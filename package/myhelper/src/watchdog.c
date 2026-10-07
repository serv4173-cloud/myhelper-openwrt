/*
 * watchdog.c - Async Internet watchdog + Game Boost + JSON history
 * Target: Qualcomm IPQ5312 / ARM64 (Xiaomi Router BE3600)
 *
 * Two independent ICMP probes:
 *   - Internet health (1.1.1.1 / 8.8.8.8) -> g_history
 *   - Gaming device health (from /tmp/myhelper_gaming_ip) -> g_history_device
 */

#include <stdio.h>
#include <stdlib.h>
#include <stdarg.h>
#include <string.h>
#include <stdint.h>
#include <unistd.h>
#include <errno.h>
#include <signal.h>
#include <syslog.h>
#include <time.h>
#include <getopt.h>
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <netinet/in.h>
#include <netinet/ip_icmp.h>
#include <arpa/inet.h>
#include <netdb.h>

#include <libubus.h>
#include <libubox/blobmsg.h>
#include <libubox/blobmsg_json.h>
#include <libubox/uloop.h>
#include <libubox/utils.h>

/* ---------------- Tunables ---------------- */
#define DEFAULT_INTERVAL      60
#define DEFAULT_THRESHOLD     3
#define PING_TIMEOUT_SEC      3
#define HISTORY_SIZE          120
#define MAX_PROBES            4
#define QOS_REAPPLY_DELAY_MS  8000
#define HISTORY_FILE          "/tmp/myhelper_history.json"
#define HISTORY_FLUSH_EVERY   10
#define HISTORY_VERSION       1
#define GAMING_IP_FILE        "/tmp/myhelper_gaming_ip"

/* ---------------- Logging ---------------- */
#ifdef MYHELPER_DEBUG_STDOUT
static void debug_log(int priority, const char *fmt, ...)
{
    (void)priority;
    time_t t = time(NULL);
    struct tm tm_info;
    localtime_r(&t, &tm_info);

    char time_str[26];
    strftime(time_str, sizeof(time_str), "%Y-%m-%d %H:%M:%S", &tm_info);

    va_list ap;
    va_start(ap, fmt);
    printf("[%s] ", time_str);
    vprintf(fmt, ap);
    printf("\n");
    fflush(stdout);
    va_end(ap);
}
#  define MY_LOG(pri, ...) debug_log(pri, __VA_ARGS__)
#else
#  define MY_LOG(pri, ...) syslog(pri, __VA_ARGS__)
#endif

/* ---------------- Runtime config ---------------- */
static int  cfg_interval  = DEFAULT_INTERVAL;
static int  cfg_threshold = DEFAULT_THRESHOLD;
static char cfg_wan[32]   = "wan";

/* ---------------- Live state ---------------- */
static int      g_internet_ok      = 0;
static int      g_fail_count       = 0;
static uint32_t g_recovery_count   = 0;
static uint32_t g_last_recovery_ts = 0;
static uint32_t g_start_time       = 0;

/* ---------------- Ring buffer ---------------- */
struct ping_sample {
    uint8_t  ok;
    uint32_t rtt_us;
};

static struct ping_sample g_history[HISTORY_SIZE];
static int g_history_idx          = 0;
static int g_history_count        = 0;

static struct ping_sample g_history_device[HISTORY_SIZE];
static int g_history_device_idx   = 0;
static int g_history_device_count = 0;

static int g_samples_since_flush  = 0;

/* ---------------- Probe targets ---------------- */
static const char *g_probe_hosts[MAX_PROBES] = { "1.1.1.1", "8.8.8.8", NULL };

static char g_gaming_ip[INET_ADDRSTRLEN] = "";

/* ---------------- Probe orchestration state ---------------- */
struct probe_child {
    struct uloop_process proc;
    int                  is_device;
};

static int      g_net_pending   = 0;
static int      g_net_alive     = 0;
static uint64_t g_net_start_us  = 0;

static int      g_dev_pending   = 0;
static int      g_dev_alive     = 0;
static uint64_t g_dev_start_us  = 0;

/* ---------------- uloop / ubus ---------------- */
static struct uloop_timeout  g_check_timer;
static struct uloop_timeout  g_qos_timer;
static struct ubus_context  *g_ubus_ctx;
static struct blob_buf       g_bbuf;

/* ---------------- Forward declarations ---------------- */
static void handle_probe_result(int alive, uint32_t rtt_us);
static void handle_device_probe_result(int alive, uint32_t rtt_us);
static void start_probe(void);
static void start_device_probe(void);
static void history_save(void);
static void reapply_game_qos(void);
static void recover_wan(void);

/* ============================================================
 *  Utilities
 * ============================================================ */
static uint64_t now_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint64_t)ts.tv_sec * 1000000ull + (uint64_t)(ts.tv_nsec / 1000);
}

static void rstrip_newline(char *s)
{
    size_t len = strlen(s);
    while (len > 0 && (s[len-1] == '\n' || s[len-1] == '\r'))
        s[--len] = '\0';
}

static void refresh_gaming_ip(void)
{
    FILE *f = fopen(GAMING_IP_FILE, "r");
    if (!f) {
        if (g_gaming_ip[0] != '\0')
            MY_LOG(LOG_INFO, "Gaming IP file gone, device probe disabled");
        g_gaming_ip[0] = '\0';
        return;
    }

    char buf[INET_ADDRSTRLEN] = {0};
    if (fgets(buf, sizeof(buf), f)) {
        rstrip_newline(buf);
        if (strcmp(buf, g_gaming_ip) != 0) {
            MY_LOG(LOG_INFO, "Gaming probe target changed: '%s' -> '%s'",
                   g_gaming_ip, buf);
            strncpy(g_gaming_ip, buf, sizeof(g_gaming_ip) - 1);
            g_gaming_ip[sizeof(g_gaming_ip) - 1] = '\0';

            g_history_device_idx   = 0;
            g_history_device_count = 0;
        }
    } else {
        g_gaming_ip[0] = '\0';
    }
    fclose(f);
}

/* ============================================================
 *  Signal handling
 * ============================================================ */
static void on_signal(int sig)
{
    (void)sig;
    uloop_end();
}

/* ============================================================
 *  History persistence
 * ============================================================ */
static const struct blobmsg_policy sample_policy[] = {
    [0] = { .name = "ok",     .type = BLOBMSG_TYPE_INT8  },
    [1] = { .name = "rtt_us", .type = BLOBMSG_TYPE_INT32 },
};

static void history_load_into(const char *key,
                              struct ping_sample *buf, size_t buf_sz,
                              int *idx_out, int *cnt_out, int *samples_out)
{
    *idx_out = 0;
    *cnt_out = 0;
    *samples_out = 0;

    FILE *f = fopen(HISTORY_FILE, "r");
    if (!f) return;

    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (sz <= 0 || sz > 1024 * 1024) { fclose(f); return; }

    char *json = malloc((size_t)sz + 1);
    if (!json) { fclose(f); return; }
    if (fread(json, 1, (size_t)sz, f) != (size_t)sz) {
        free(json); fclose(f); return;
    }
    json[sz] = '\0';
    fclose(f);

    struct blob_buf b = {0};
    blob_buf_init(&b, 0);
    if (!blobmsg_add_json_from_string(&b, json)) {
        blob_buf_free(&b); free(json); return;
    }

    struct blob_attr *arr = blobmsg_lookup(b.head, key);
    if (!arr || blobmsg_type(arr) != BLOBMSG_TYPE_ARRAY) {
        blob_buf_free(&b); free(json); return;
    }

    struct blob_attr *cur;
    int rem = blobmsg_len(arr);
    blobmsg_for_each_attr(cur, arr, rem) {
        if (blobmsg_type(cur) != BLOBMSG_TYPE_TABLE) continue;

        struct blob_attr *tb[ARRAY_SIZE(sample_policy)];
        blobmsg_parse(sample_policy, ARRAY_SIZE(sample_policy), tb,
                      blobmsg_data(cur), blobmsg_len(cur));
        if (!tb[0] || !tb[1]) continue;

        struct ping_sample *slot = &buf[*idx_out];
        slot->ok     = blobmsg_get_u8 (tb[0]);
        slot->rtt_us = blobmsg_get_u32(tb[1]);

        *idx_out = (*idx_out + 1) % (int)buf_sz;
        if (*cnt_out < (int)buf_sz)
            (*cnt_out)++;
        (*samples_out)++;
    }

    blob_buf_free(&b);
    free(json);
}

static void history_load(void)
{
    int n_net = 0, n_dev = 0;
    history_load_into("samples", g_history, HISTORY_SIZE,
                      &g_history_idx, &g_history_count, &n_net);
    history_load_into("samples_device", g_history_device, HISTORY_SIZE,
                      &g_history_device_idx, &g_history_device_count, &n_dev);
    MY_LOG(LOG_INFO, "History restored: internet=%d device=%d samples",
           n_net, n_dev);
}

static void history_serialize_into(struct blob_buf *b, const char *key,
                                   struct ping_sample *buf, size_t buf_sz,
                                   int idx, int cnt)
{
    void *arr = blobmsg_open_array(b, key);
    for (int i = 0; i < cnt; i++) {
        int k = (idx - cnt + i + (int)buf_sz) % (int)buf_sz;
        void *e = blobmsg_open_table(b, NULL);
        blobmsg_add_u8 (b, "ok",     buf[k].ok);
        blobmsg_add_u32(b, "rtt_us", buf[k].rtt_us);
        blobmsg_close_table(b, e);
    }
    blobmsg_close_array(b, arr);
}

static void history_save(void)
{
    struct blob_buf b = {0};
    blob_buf_init(&b, 0);

    blobmsg_add_u32(&b, "version", HISTORY_VERSION);
    history_serialize_into(&b, "samples",
                           g_history, HISTORY_SIZE,
                           g_history_idx, g_history_count);
    history_serialize_into(&b, "samples_device",
                           g_history_device, HISTORY_SIZE,
                           g_history_device_idx, g_history_device_count);

    char *json = blobmsg_format_json(b.head, true);
    if (json) {
        FILE *f = fopen(HISTORY_FILE, "w");
        if (f) {
            if (fputs(json, f) >= 0) fflush(f);
            fclose(f);
        }
        free(json);
    }
    blob_buf_free(&b);
}

static void history_push(int ok, uint32_t rtt_us)
{
    g_history[g_history_idx].ok     = (uint8_t)ok;
    g_history[g_history_idx].rtt_us = rtt_us;
    g_history_idx = (g_history_idx + 1) % HISTORY_SIZE;
    if (g_history_count < HISTORY_SIZE) g_history_count++;

    if (++g_samples_since_flush >= HISTORY_FLUSH_EVERY) {
        g_samples_since_flush = 0;
        history_save();
    }
}

static void history_push_device(int ok, uint32_t rtt_us)
{
    g_history_device[g_history_device_idx].ok     = (uint8_t)ok;
    g_history_device[g_history_device_idx].rtt_us = rtt_us;
    g_history_device_idx = (g_history_device_idx + 1) % HISTORY_SIZE;
    if (g_history_device_count < HISTORY_SIZE) g_history_device_count++;
}

/* ============================================================
 *  ICMP helpers
 * ============================================================ */
static unsigned short icmp_checksum(const void *buf, int len)
{
    const unsigned short *p = buf;
    unsigned int sum = 0;
    while (len > 1) { sum += *p++; len -= 2; }
    if (len == 1)   { sum += *(const unsigned char *)p; }
    sum  = (sum >> 16) + (sum & 0xffff);
    sum += (sum >> 16);
    return (unsigned short)~sum;
}

static int ping_host(const char *host, int timeout_sec)
{
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family   = AF_INET;
    hints.ai_socktype = SOCK_RAW;
    hints.ai_protocol = IPPROTO_ICMP;

    if (getaddrinfo(host, NULL, &hints, &res) != 0 || !res) return 0;
    int sock = socket(AF_INET, SOCK_RAW, IPPROTO_ICMP);
    if (sock < 0) { freeaddrinfo(res); return 0; }

    struct timeval tv = { .tv_sec = timeout_sec, .tv_usec = 0 };
    setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));

    unsigned char pkt[64] = {0};
    struct icmphdr *icmp = (struct icmphdr *)pkt;
    icmp->type             = ICMP_ECHO;
    icmp->code             = 0;
    icmp->un.echo.id       = htons((uint16_t)(getpid() & 0xffff));
    icmp->un.echo.sequence = htons(1);
    icmp->checksum         = icmp_checksum(pkt, sizeof(pkt));

    struct sockaddr_in *addr = (struct sockaddr_in *)res->ai_addr;
    int ok = 0;
    if (sendto(sock, pkt, sizeof(pkt), 0,
               (struct sockaddr *)addr, sizeof(*addr)) > 0) {
        unsigned char reply[1024];
        struct sockaddr_in from;
        socklen_t fromlen = sizeof(from);
        if (recvfrom(sock, reply, sizeof(reply), 0,
                     (struct sockaddr *)&from, &fromlen) > 0)
            ok = 1;
    }
    close(sock);
    freeaddrinfo(res);
    return ok;
}

/* ============================================================
 *  Process helpers
 * ============================================================ */
static int run_command(const char *path, char *const argv[])
{
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        freopen("/dev/null", "w", stdout);
        freopen("/dev/null", "w", stderr);
        execv(path, argv);
        _exit(127);
    }
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) return -1;
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}

static void recover_wan(void)
{
    MY_LOG(LOG_WARNING, "Attempting WAN recovery (interface=%s)", cfg_wan);
    char iface_path[64];
    snprintf(iface_path, sizeof(iface_path),
             "network.interface.%s", cfg_wan);

    char *down_argv[] = { "ubus", "call", iface_path, "down", NULL };
    char *up_argv[]   = { "ubus", "call", iface_path, "up",   NULL };
    char *ifup_argv[] = { "ifup", cfg_wan, NULL };

    int rc_down = run_command("/sbin/ubus", down_argv);
    MY_LOG(LOG_INFO, "ubus down rc=%d", rc_down);
    sleep(2);
    int rc_up = run_command("/sbin/ubus", up_argv);
    MY_LOG(LOG_INFO, "ubus up rc=%d", rc_up);

    if (rc_down != 0 || rc_up != 0) {
        int rc = run_command("/sbin/ifup", ifup_argv);
        MY_LOG(LOG_WARNING, "ifup %s fallback rc=%d", cfg_wan, rc);
    }
}

static void reapply_game_qos(void)
{
    pid_t pid = fork();
    if (pid < 0) return;
    if (pid == 0) {
        freopen("/dev/null", "w", stdout);
        freopen("/dev/null", "w", stderr);
        execl("/etc/init.d/myhelper-watchdog",
              "myhelper-watchdog", "apply_qos", (char *)NULL);
        _exit(127);
    }
    waitpid(pid, NULL, 0);
    refresh_gaming_ip();
}

/* ============================================================
 *  Probe orchestration
 * ============================================================ */
static void probe_child_cb(struct uloop_process *p, int ret)
{
    struct probe_child *pc = container_of(p, struct probe_child, proc);
    int ok = (WIFEXITED(ret) && WEXITSTATUS(ret) == 0);

    if (pc->is_device) {
        if (ok) g_dev_alive = 1;
        g_dev_pending--;
        if (g_dev_pending == 0) {
            uint32_t rtt = (uint32_t)(now_us() - g_dev_start_us);
            handle_device_probe_result(g_dev_alive, rtt);
        }
    } else {
        if (ok) g_net_alive = 1;
        g_net_pending--;
        if (g_net_pending == 0) {
            uint32_t rtt = (uint32_t)(now_us() - g_net_start_us);
            handle_probe_result(g_net_alive, rtt);
        }
    }
    free(pc);
}

static void spawn_probe(const char *host, int is_device)
{
    struct probe_child *pc = calloc(1, sizeof(*pc));
    if (!pc) return;

    pc->is_device = is_device;
    pc->proc.cb   = probe_child_cb;
    pc->proc.pid  = fork();

    if (pc->proc.pid == 0) {
        freopen("/dev/null", "w", stdout);
        freopen("/dev/null", "w", stderr);
        _exit(ping_host(host, PING_TIMEOUT_SEC) ? 0 : 1);
    }
    if (pc->proc.pid < 0) { free(pc); return; }

    if (is_device) g_dev_pending++;
    else           g_net_pending++;

    uloop_process_add(&pc->proc);
}

static void start_probe(void)
{
    g_net_pending  = 0;
    g_net_alive    = 0;
    g_net_start_us = now_us();

    for (int i = 0; g_probe_hosts[i] != NULL && i < MAX_PROBES; i++)
        spawn_probe(g_probe_hosts[i], 0);

    if (g_net_pending == 0)
        handle_probe_result(0, 0);

    refresh_gaming_ip();
    if (g_gaming_ip[0] != '\0')
        start_device_probe();
}

static void start_device_probe(void)
{
    g_dev_pending  = 0;
    g_dev_alive    = 0;
    g_dev_start_us = now_us();

    if (g_gaming_ip[0] == '\0')
        return;

    spawn_probe(g_gaming_ip, 1);

    if (g_dev_pending == 0)
        handle_device_probe_result(0, 0);
}

static void handle_probe_result(int alive, uint32_t rtt_us)
{
    if (alive) {
        if (g_fail_count > 0)
            MY_LOG(LOG_INFO, "Connectivity restored after %d failure(s)",
                   g_fail_count);
        g_fail_count  = 0;
        g_internet_ok = 1;
        history_push(1, rtt_us);
    } else {
        g_fail_count++;
        g_internet_ok = 0;
        MY_LOG(LOG_WARNING, "Internet probe failed (%d/%d)",
               g_fail_count, cfg_threshold);
        history_push(0, 0);

        if (g_fail_count >= cfg_threshold) {
            recover_wan();
            g_recovery_count++;
            g_last_recovery_ts = (uint32_t)time(NULL);
            g_fail_count = 0;
            uloop_timeout_set(&g_qos_timer, QOS_REAPPLY_DELAY_MS);
        }
    }
    uloop_timeout_set(&g_check_timer, cfg_interval * 1000);
}

static void handle_device_probe_result(int alive, uint32_t rtt_us)
{
    if (alive) {
        history_push_device(1, rtt_us);
        MY_LOG(LOG_INFO, "Gaming device %s RTT %u us", g_gaming_ip, rtt_us);
    } else {
        history_push_device(0, 0);
        MY_LOG(LOG_INFO, "Gaming device %s probe failed", g_gaming_ip);
    }
}

static void check_timer_cb(struct uloop_timeout *t)
{
    (void)t;
    start_probe();
}

static void qos_timer_cb(struct uloop_timeout *t)
{
    (void)t;
    reapply_game_qos();
}

/* ============================================================
 *  ubus methods
 * ============================================================ */
static void bbuf_add_history(struct blob_buf *b, const char *key,
                             struct ping_sample *buf, int idx, int cnt)
{
    void *arr = blobmsg_open_array(b, key);
    for (int i = 0; i < cnt; i++) {
        int k = (idx - cnt + i + HISTORY_SIZE) % HISTORY_SIZE;
        void *e = blobmsg_open_table(b, NULL);
        blobmsg_add_u8 (b, "ok",     buf[k].ok);
        blobmsg_add_u32(b, "rtt_us", buf[k].rtt_us);
        blobmsg_close_table(b, e);
    }
    blobmsg_close_array(b, arr);
}

static int ubus_status_cb(struct ubus_context *ctx, struct ubus_object *obj,
                          struct ubus_request_data *req, const char *method,
                          struct blob_attr *msg)
{
    (void)obj; (void)method; (void)msg;

    blob_buf_init(&g_bbuf, 0);
    blobmsg_add_u8 (&g_bbuf, "internet",       g_internet_ok);
    blobmsg_add_u32(&g_bbuf, "fail_count",     g_fail_count);
    blobmsg_add_u32(&g_bbuf, "threshold",      cfg_threshold);
    blobmsg_add_u32(&g_bbuf, "interval",       cfg_interval);
    blobmsg_add_u32(&g_bbuf, "uptime",         (uint32_t)time(NULL) - g_start_time);
    blobmsg_add_u32(&g_bbuf, "recovery_count", g_recovery_count);
    blobmsg_add_u32(&g_bbuf, "last_recovery",  g_last_recovery_ts);
    blobmsg_add_string(&g_bbuf, "gaming_ip",   g_gaming_ip);

    bbuf_add_history(&g_bbuf, "history",
                     g_history, g_history_idx, g_history_count);
    bbuf_add_history(&g_bbuf, "history_device",
                     g_history_device, g_history_device_idx, g_history_device_count);

    ubus_send_reply(ctx, req, g_bbuf.head);
    return 0;
}

static int ubus_force_recovery_cb(struct ubus_context *ctx, struct ubus_object *obj,
                                  struct ubus_request_data *req, const char *method,
                                  struct blob_attr *msg)
{
    (void)obj; (void)method; (void)msg;
    MY_LOG(LOG_NOTICE, "Manual recovery triggered via ubus");
    recover_wan();
    g_recovery_count++;
    g_last_recovery_ts = (uint32_t)time(NULL);
    uloop_timeout_set(&g_qos_timer, QOS_REAPPLY_DELAY_MS);

    blob_buf_init(&g_bbuf, 0);
    blobmsg_add_u8 (&g_bbuf, "ok", 1);
    blobmsg_add_u32(&g_bbuf, "recovery_count", g_recovery_count);
    ubus_send_reply(ctx, req, g_bbuf.head);
    return 0;
}

static int ubus_qos_reapply_cb(struct ubus_context *ctx, struct ubus_object *obj,
                               struct ubus_request_data *req, const char *method,
                               struct blob_attr *msg)
{
    (void)obj; (void)method; (void)msg;
    MY_LOG(LOG_NOTICE, "QoS reapply triggered via ubus");
    reapply_game_qos();

    blob_buf_init(&g_bbuf, 0);
    blobmsg_add_u8(&g_bbuf, "ok", 1);
    ubus_send_reply(ctx, req, g_bbuf.head);
    return 0;
}

static const struct ubus_method myhelper_methods[] = {
    UBUS_METHOD_NOARG("status",         ubus_status_cb),
    UBUS_METHOD_NOARG("force_recovery", ubus_force_recovery_cb),
    UBUS_METHOD_NOARG("qos_reapply",    ubus_qos_reapply_cb),
};

static struct ubus_object_type myhelper_obj_type =
    UBUS_OBJECT_TYPE("myhelper", myhelper_methods);

static struct ubus_object myhelper_obj = {
    .name      = "myhelper",
    .type      = &myhelper_obj_type,
    .methods   = myhelper_methods,
    .n_methods = ARRAY_SIZE(myhelper_methods),
};

/* ============================================================
 *  main
 * ============================================================ */
static void parse_args(int argc, char **argv, int *foreground)
{
    int opt;
    while ((opt = getopt(argc, argv, "fi:t:w:")) != -1) {
        switch (opt) {
        case 'f': *foreground = 1; break;
        case 'i': cfg_interval  = atoi(optarg); if (cfg_interval  < 5) cfg_interval  = 5; break;
        case 't': cfg_threshold = atoi(optarg); if (cfg_threshold < 1) cfg_threshold = 1; break;
        case 'w':
            strncpy(cfg_wan, optarg, sizeof(cfg_wan) - 1);
            cfg_wan[sizeof(cfg_wan) - 1] = '\0';
            break;
        default:
            fprintf(stderr,
                "Usage: %s -f [-i interval] [-t threshold] [-w wan_iface]\n",
                argv[0]);
            exit(1);
        }
    }
}

int main(int argc, char **argv)
{
    int foreground = 0;
    parse_args(argc, argv, &foreground);

    openlog("myhelper-wd", LOG_PID | LOG_CONS, LOG_DAEMON);
    MY_LOG(LOG_INFO, "Watchdog starting: interval=%d threshold=%d wan=%s",
           cfg_interval, cfg_threshold, cfg_wan);

    if (!foreground) {
        if (daemon(0, 0) != 0) {
            MY_LOG(LOG_ERR, "daemon() failed: %s", strerror(errno));
            closelog();
            return 1;
        }
    }

    signal(SIGTERM, on_signal);
    signal(SIGINT,  on_signal);
    signal(SIGPIPE, SIG_IGN);

    g_start_time = (uint32_t)time(NULL);
    uloop_init();
    history_load();

    g_ubus_ctx = ubus_connect(NULL);
    if (!g_ubus_ctx) {
        MY_LOG(LOG_WARNING, "ubus_connect failed: %s", strerror(errno));
    } else {
        ubus_add_uloop(g_ubus_ctx);
        if (ubus_add_object(g_ubus_ctx, &myhelper_obj) != 0)
            MY_LOG(LOG_WARNING, "ubus_add_object(myhelper) failed");
        else
            MY_LOG(LOG_INFO, "ubus object 'myhelper' registered");
    }

    g_check_timer.cb = check_timer_cb;
    g_qos_timer.cb   = qos_timer_cb;

    uloop_timeout_set(&g_check_timer, 1000);
    uloop_run();

    history_save();
    MY_LOG(LOG_INFO, "History flushed on shutdown");

    uloop_timeout_cancel(&g_check_timer);
    uloop_timeout_cancel(&g_qos_timer);
    if (g_ubus_ctx) {
        ubus_remove_object(g_ubus_ctx, &myhelper_obj);
        ubus_free(g_ubus_ctx);
    }
    uloop_done();
    MY_LOG(LOG_INFO, "Watchdog stopped");
    closelog();
    return 0;
}
