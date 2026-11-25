// Starts the embedded Node.js runtime (nodejs-mobile) that runs the MausDroid
// engine, and forwards its console output to Android's log.
#include <jni.h>
#include <string>
#include <vector>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <android/log.h>
#include "node.h"

static int pipe_stdout[2];
static FILE *log_file = nullptr;
static int pipe_stderr[2];

static void *log_thread(void *arg) {
    int fd = *(int *)arg;
    int prio = fd == pipe_stdout[0] ? ANDROID_LOG_INFO : ANDROID_LOG_WARN;
    char buf[2048];
    ssize_t n;
    while ((n = read(fd, buf, sizeof buf - 1)) > 0) {
        if (buf[n - 1] == '\n') n--;
        buf[n] = 0;
        __android_log_write(prio, "MausEngine", buf);
        if (log_file) {
            fprintf(log_file, "%s\n", buf);
            fflush(log_file);
        }
    }
    return nullptr;
}

static void redirect_output() {
    setvbuf(stdout, nullptr, _IONBF, 0);
    setvbuf(stderr, nullptr, _IONBF, 0);
    pipe(pipe_stdout);
    pipe(pipe_stderr);
    dup2(pipe_stdout[1], STDOUT_FILENO);
    dup2(pipe_stderr[1], STDERR_FILENO);
    pthread_t t1, t2;
    pthread_create(&t1, nullptr, log_thread, &pipe_stdout[0]);
    pthread_create(&t2, nullptr, log_thread, &pipe_stderr[0]);
    pthread_detach(t1);
    pthread_detach(t2);
}

extern "C" JNIEXPORT void JNICALL
Java_au_mausdroid_NodeRuntime_setLogFile(JNIEnv *env, jclass, jstring path) {
    const char *p = env->GetStringUTFChars(path, nullptr);
    log_file = fopen(p, "w");
    env->ReleaseStringUTFChars(path, p);
}

extern "C" JNIEXPORT void JNICALL
Java_au_mausdroid_NodeRuntime_setEnv(JNIEnv *env, jclass, jstring key, jstring value) {
    const char *k = env->GetStringUTFChars(key, nullptr);
    const char *v = env->GetStringUTFChars(value, nullptr);
    setenv(k, v, 1);
    env->ReleaseStringUTFChars(key, k);
    env->ReleaseStringUTFChars(value, v);
}

extern "C" JNIEXPORT jint JNICALL
Java_au_mausdroid_NodeRuntime_start(JNIEnv *env, jclass, jobjectArray arguments) {
    redirect_output();
    jsize argc = env->GetArrayLength(arguments);
    // node::Start expects all arguments in one contiguous block of memory.
    std::vector<std::string> args;
    size_t total = 0;
    for (jsize i = 0; i < argc; i++) {
        auto s = (jstring)env->GetObjectArrayElement(arguments, i);
        const char *c = env->GetStringUTFChars(s, nullptr);
        args.emplace_back(c);
        total += strlen(c) + 1;
        env->ReleaseStringUTFChars(s, c);
    }
    char *block = (char *)calloc(total, 1);
    std::vector<char *> argv;
    char *cur = block;
    for (auto &a : args) {
        memcpy(cur, a.c_str(), a.size());
        argv.push_back(cur);
        cur += a.size() + 1;
    }
    int code = node::Start((int)argc, argv.data());
    free(block);
    return code;
}
