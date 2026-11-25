package au.mausdroid

import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * The phone's own voice: speech recognition (you talk) and text-to-speech
 * (bots answer aloud) through any voice engine installed on the phone —
 * Google, Samsung, or a Kokoro engine — with its voices, speed and pitch.
 * Calls queue short pieces of the reply as they arrive (say) and can be
 * interrupted at once (stopSpeaking).
 */
class Voice(private val ctx: Context) {
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    @Volatile private var ttsReady = false
    @Volatile private var enginePkg: String? = null
    @Volatile private var voiceName: String? = null
    @Volatile private var pitch = 1f
    @Volatile private var callMode = false
    private var recognizer: SpeechRecognizer? = null
    private val pending = AtomicInteger(0)
    private val doneCallbacks = ConcurrentHashMap<String, () -> Unit>()

    init { initTts(null, null) }

    private fun initTts(engine: String?, latch: CountDownLatch?) {
        main.post {
            ttsReady = false
            tts?.shutdown()
            pending.set(0)
            val listener = TextToSpeech.OnInitListener { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) {
                    tts?.setOnUtteranceProgressListener(progress)
                    applyVoice()
                }
                latch?.countDown()
            }
            enginePkg = engine
            tts = if (engine.isNullOrBlank()) TextToSpeech(ctx, listener) else TextToSpeech(ctx, listener, engine)
        }
    }

    private val progress = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) = finished(utteranceId)
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = finished(utteranceId)
        override fun onStop(utteranceId: String?, interrupted: Boolean) = finished(utteranceId)
    }

    private fun finished(id: String?) {
        if (pending.decrementAndGet() < 0) pending.set(0)
        id?.let { doneCallbacks.remove(it)?.let { cb -> main.post { cb() } } }
    }

    private fun applyVoice() {
        val t = tts ?: return
        t.setPitch(pitch)
        val wanted = voiceName
        val v = if (wanted.isNullOrBlank()) null else runCatching { t.voices?.firstOrNull { it.name == wanted } }.getOrNull()
        if (v != null) t.voice = v else runCatching { t.language = Locale.getDefault() }
        t.setAudioAttributes(
            AudioAttributes.Builder()
                .setUsage(if (callMode) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build()
        )
    }

    /** Chooses the voice engine (package, blank = phone default), voice and pitch. */
    fun configure(engine: String?, voice: String?, newPitch: Float) {
        val eng = engine?.takeIf { it.isNotBlank() }
        pitch = newPitch.coerceIn(0.5f, 2f)
        voiceName = voice
        if (eng != enginePkg || tts == null) {
            val latch = CountDownLatch(1)
            initTts(eng, latch)
            latch.await(8, TimeUnit.SECONDS)
        } else main.post { applyVoice() }
    }

    /** Voice engines installed on the phone (Kokoro shows here when its app is a voice engine). */
    fun engines(): JSONArray {
        val out = JSONArray()
        val latch = CountDownLatch(1)
        main.post {
            runCatching { tts?.engines?.forEach { out.put(JSONObject().put("name", it.name).put("label", it.label)) } }
            latch.countDown()
        }
        latch.await(3, TimeUnit.SECONDS)
        return out
    }

    /** Voices of an engine (switches to it first). */
    fun voices(engine: String?): JSONObject {
        configure(engine, voiceName, pitch)
        val out = JSONArray()
        val latch = CountDownLatch(1)
        main.post {
            runCatching {
                tts?.voices?.sortedBy { it.name }?.forEach {
                    out.put(
                        JSONObject().put("name", it.name).put("locale", it.locale?.toLanguageTag() ?: "")
                            .put("network", it.isNetworkConnectionRequired).put("quality", it.quality)
                            .put("notInstalled", it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) == true)
                    )
                }
            }
            latch.countDown()
        }
        latch.await(5, TimeUnit.SECONDS)
        return JSONObject().put("engine", enginePkg ?: "").put("ready", ttsReady).put("voices", out)
    }

    /** Calls: route audio like a phone call so the echo canceller hears Maus's voice and ignores it. */
    fun setCallMode(on: Boolean) {
        callMode = on
        val am = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        runCatching {
            am.mode = if (on) AudioManager.MODE_IN_COMMUNICATION else AudioManager.MODE_NORMAL
            @Suppress("DEPRECATION")
            am.isSpeakerphoneOn = on
        }
        main.post { applyVoice() }
    }

    interface Listener {
        fun onPartial(text: String) {}
        fun onLevel(rms: Float) {}
        fun onFinal(text: String)
        fun onError(message: String, code: Int = -1)
    }

    fun available() = SpeechRecognizer.isRecognitionAvailable(ctx)

    /** Starts listening (must be called on the main thread). */
    fun listen(l: Listener, silenceMs: Long = 0) {
        recognizer?.destroy()
        recognizer = null
        if (!available()) return l.onError("Speech recognition isn't available on this phone. Install or enable Google's speech services.")
        if (ctx.checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) != android.content.pm.PackageManager.PERMISSION_GRANTED)
            return l.onError("MausDroid needs microphone permission (Settings → Voice & assistant → Microphone).", SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS)
        val r = SpeechRecognizer.createSpeechRecognizer(ctx)
        recognizer = r
        r.setRecognitionListener(object : RecognitionListener {
            override fun onReadyForSpeech(params: Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) = l.onLevel(rmsdB)
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onEvent(eventType: Int, params: Bundle?) {}
            override fun onPartialResults(partial: Bundle?) {
                partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.let { l.onPartial(it) }
            }
            override fun onResults(results: Bundle?) {
                val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
                if (text.isBlank()) l.onError("I didn't catch that.", SpeechRecognizer.ERROR_NO_MATCH) else l.onFinal(text)
            }
            override fun onError(error: Int) {
                l.onError(
                    when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "I didn't catch that."
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "MausDroid needs microphone permission (Settings → Voice & assistant → Microphone)."
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "No connection for speech recognition."
                        SpeechRecognizer.ERROR_RECOGNIZER_BUSY -> "The speech service was busy."
                        SpeechRecognizer.ERROR_AUDIO -> "The microphone couldn't be used (another app may be using it)."
                        else -> "Listening failed (code $error)."
                    },
                    error,
                )
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
            .putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, ctx.packageName)
        if (silenceMs > 0) {
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs)
            intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, silenceMs)
        }
        r.startListening(intent)
    }

    fun stopListening() = main.post { recognizer?.stopListening() }

    /**
     * Listens once and returns (words, error, errorCode). "Didn't catch that" is
     * not an error for callers: words come back empty. A busy speech service is
     * retried once.
     */
    fun listenBlocking(timeoutSec: Long = 45, silenceMs: Long = 0): Triple<String?, String?, Int> {
        var attempt = 0
        while (true) {
            val latch = CountDownLatch(1)
            var text: String? = null
            var err: String? = null
            var code = -1
            main.post {
                listen(object : Listener {
                    override fun onFinal(t: String) { text = t; latch.countDown() }
                    override fun onError(message: String, c: Int) { err = message; code = c; latch.countDown() }
                }, silenceMs)
            }
            if (!latch.await(timeoutSec, TimeUnit.SECONDS)) { stopListening(); return Triple(null, "Listening timed out.", -2) }
            val retry = code == SpeechRecognizer.ERROR_RECOGNIZER_BUSY || code == SpeechRecognizer.ERROR_CLIENT || code == 11 /* server disconnected */
            if (retry && attempt++ == 0) { Thread.sleep(250); continue }
            return Triple(text, err, code)
        }
    }

    /** Speaks text aloud, replacing anything being said; onDone runs when finished. */
    fun speak(text: String, rate: Float = 1f, onDone: (() -> Unit)? = null) = enqueue(text, rate, flush = true, onDone = onDone)

    /** Adds a piece to what's being said (calls speak replies piece by piece as they arrive). */
    fun say(text: String, rate: Float = 1f) = enqueue(text, rate, flush = false, onDone = null)

    private fun enqueue(text: String, rate: Float, flush: Boolean, onDone: (() -> Unit)?) {
        if (text.isBlank()) { onDone?.let { main.post(it) }; return }
        val id = UUID.randomUUID().toString()
        val parts = text.chunked(3500)
        val ids = parts.indices.map { i -> if (i == parts.lastIndex) id else "$id-$i" }
        // Counted at once, so "is Maus speaking?" is true from the moment a piece is queued.
        if (flush) pending.set(0)
        pending.addAndGet(parts.size)
        if (onDone != null) doneCallbacks[id] = onDone
        main.post {
            val t = tts
            if (t == null || !ttsReady) { ids.forEach { finished(it) }; return@post }
            t.setSpeechRate(rate)
            parts.forEachIndexed { i, p ->
                val r = t.speak(p, if (flush && i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, ids[i])
                if (r != TextToSpeech.SUCCESS) finished(ids[i])
            }
        }
    }

    /** Speaks and waits until finished. */
    fun speakBlocking(text: String, rate: Float = 1f, timeoutSec: Long = 170) {
        val latch = CountDownLatch(1)
        speak(text, rate) { latch.countDown() }
        latch.await(timeoutSec, TimeUnit.SECONDS)
    }

    /** True while anything is being said or waiting to be said. */
    fun isSpeaking(): Boolean = pending.get() > 0 || (runCatching { tts?.isSpeaking }.getOrNull() == true)

    /** Stops at once and drops anything queued (used when you interrupt). */
    fun stopSpeaking() {
        pending.set(0)
        val cbs = doneCallbacks.values.toList()
        doneCallbacks.clear()
        main.post {
            tts?.stop()
            cbs.forEach { it() }
        }
    }

    fun shutdown() = main.post {
        recognizer?.destroy()
        tts?.shutdown()
    }
}
