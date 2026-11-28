package au.mausdroid

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Opening conversations and handing text to other apps — always with the
 * person in control: DanDroid never presses Send in another app.
 *  - "Open conversation": the notification's own action (exact chat) when it's
 *    still known, otherwise the app itself.
 *  - WhatsApp: the draft prefilled (they choose the chat, review, send).
 *  - Other apps: share the text, or open them so it can be pasted.
 */
object Conversations {
    private val actions = object : LinkedHashMap<String, Pair<String, PendingIntent>>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Pair<String, PendingIntent>>?) = size > 400
    }

    @Synchronized fun remember(key: String, pkg: String, pi: PendingIntent) { actions[key] = pkg to pi }

    /** Opens the conversation; returns "conversation", "app" or "none". */
    @Synchronized fun open(ctx: Context, key: String?, pkg: String?): String {
        key?.let { actions[it] }?.let { (_, pi) -> if (runCatching { pi.send() }.isSuccess) return "conversation" }
        val launch = pkg?.let { ctx.packageManager.getLaunchIntentForPackage(it) } ?: return "none"
        ctx.startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return "app"
    }

    fun installed(ctx: Context, pkg: String) = runCatching { ctx.packageManager.getPackageInfo(pkg, 0); true }.getOrDefault(false)

    fun copy(ctx: Context, text: String, label: String = "DanDroid") {
        val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        cm.setPrimaryClip(android.content.ClipData.newPlainText(label, text))
    }

    /**
     * Hands text to an app: whatsapp (prefilled, they pick the chat), sms, email
     * (subject + body, they add the recipient), a package (share to it), url
     * (open, in Chrome when asked), or the system share sheet.
     */
    fun send(ctx: Context, kind: String, text: String, pkg: String?, subject: String?, to: String?): String {
        val i: Intent = when (kind) {
            "whatsapp" -> {
                val wa = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { installed(ctx, it) }
                if (wa != null) Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text).setPackage(wa)
                else Intent(Intent.ACTION_VIEW, Uri.parse("https://wa.me/?text=" + Uri.encode(text)))
            }
            "sms" -> Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:" + Uri.encode(to ?: ""))).putExtra("sms_body", text)
            "email" -> Intent(Intent.ACTION_SENDTO, Uri.parse("mailto:" + Uri.encode(to ?: ""))).putExtra(Intent.EXTRA_SUBJECT, subject ?: "").putExtra(Intent.EXTRA_TEXT, text)
            "url" -> Intent(Intent.ACTION_VIEW, Uri.parse(text)).apply { if (pkg != null && installed(ctx, pkg)) setPackage(pkg) }
            "package" -> Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text).apply { if (!subject.isNullOrBlank()) putExtra(Intent.EXTRA_SUBJECT, subject); if (pkg != null) setPackage(pkg) }
            else -> Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text), "Share")
        }
        ctx.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        return kind
    }
}
