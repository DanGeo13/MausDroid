package au.mausdroid

import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The phone's own voice: speech recognition (you talk) and text-to-speech
 * (bots answer aloud). Free, offline-capable on most phones, and works with
 * every bot, including your Claude / ChatGPT / Gemini subscriptions.
 */
class Voice(private val ctx: Context) {
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    @Volatile private var ttsReady = false
    private var recognizer: SpeechRecognizer? = null

    init {
        main.post {
            tts = TextToSpeech(ctx) { status ->
                ttsReady = status == TextToSpeech.SUCCESS
                if (ttsReady) tts?.language = Locale.getDefault()
            }
        }
    }

    interface Listener {
        fun onPartial(text: String) {}
        fun onLevel(rms: Float) {}
        fun onFinal(text: String)
        fun onError(message: String)
    }

    fun available() = SpeechRecognizer.isRecognitionAvailable(ctx)

    /** Starts listening (must be called on the main thread). */
    fun listen(l: Listener) {
        recognizer?.destroy()
        if (!available()) return l.onError("Speech recognition isn't available on this phone. Install or enable Google's speech services.")
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
                if (text.isBlank()) l.onError("I didn't catch that.") else l.onFinal(text)
            }
            override fun onError(error: Int) {
                l.onError(
                    when (error) {
                        SpeechRecognizer.ERROR_NO_MATCH, SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "I didn't catch that."
                        SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "MausDroid needs microphone permission (open the app once and allow it)."
                        SpeechRecognizer.ERROR_NETWORK, SpeechRecognizer.ERROR_NETWORK_TIMEOUT -> "No connection for speech recognition."
                        else -> "Listening failed (code $error)."
                    }
                )
            }
        })
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            .putExtra(RecognizerIntent.EXTRA_LANGUAGE, Locale.getDefault().toLanguageTag())
        r.startListening(intent)
    }

    fun stopListening() = main.post { recognizer?.stopListening() }

    /** Listens once and returns the words (blocking; for the engine bridge). */
    fun listenBlocking(timeoutSec: Long = 45): Pair<String?, String?> {
        val latch = CountDownLatch(1)
        var text: String? = null
        var err: String? = null
        main.post {
            listen(object : Listener {
                override fun onFinal(t: String) { text = t; latch.countDown() }
                override fun onError(message: String) { err = message; latch.countDown() }
            })
        }
        if (!latch.await(timeoutSec, TimeUnit.SECONDS)) { stopListening(); err = "Listening timed out." }
        return text to err
    }

    /** Speaks text aloud; onDone runs when finished (on the main thread). */
    fun speak(text: String, rate: Float = 1f, onDone: (() -> Unit)? = null) {
        main.post {
            val t = tts
            if (t == null || !ttsReady) { onDone?.invoke(); return@post }
            t.setSpeechRate(rate)
            val id = UUID.randomUUID().toString()
            t.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) {}
                override fun onDone(utteranceId: String?) { if (utteranceId == id) main.post { onDone?.invoke() } }
                @Deprecated("Deprecated in Java")
                override fun onError(utteranceId: String?) { main.post { onDone?.invoke() } }
            })
            // Long replies are split so the phone's voice engine accepts them.
            val parts = text.chunked(3500)
            parts.forEachIndexed { i, p -> t.speak(p, if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD, null, if (i == parts.lastIndex) id else "$id-$i") }
        }
    }

    /** Speaks and waits until finished (calls: so listening doesn't hear the bot's own voice). */
    fun speakBlocking(text: String, rate: Float = 1f, timeoutSec: Long = 170) {
        val latch = CountDownLatch(1)
        speak(text, rate) { latch.countDown() }
        latch.await(timeoutSec, TimeUnit.SECONDS)
    }

    fun stopSpeaking() = main.post { tts?.stop() }

    fun shutdown() = main.post {
        recognizer?.destroy()
        tts?.shutdown()
    }
}
