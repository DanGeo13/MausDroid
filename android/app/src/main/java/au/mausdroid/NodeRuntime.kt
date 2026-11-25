package au.mausdroid

/** Thin JNI wrapper around nodejs-mobile. Node can start only once per process. */
object NodeRuntime {
    init {
        System.loadLibrary("c++_shared")
        System.loadLibrary("node")
        System.loadLibrary("mausnode")
    }

    @JvmStatic external fun setLogFile(path: String)
    @JvmStatic external fun setEnv(key: String, value: String)
    @JvmStatic external fun start(args: Array<String>): Int
}
