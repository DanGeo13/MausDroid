package au.mausdroid

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import java.io.File
import java.security.MessageDigest

/**
 * The Android side of SpeechPlayer: phrases come from the phone's voice
 * engine (Phonon when it's chosen in Settings → Voice) through Android's
 * text-to-speech service, and play through one AudioTrack. In a call the
 * track uses the phone-call audio path, so the echo canceller hears it and
 * DanDroid's own voice doesn't count as you interrupting.
 */
class TtsPhraseSynth(private val ctx: Context, private val recorder: VoiceRecorder) : SpeechPlayer.PhraseSynth {
    private val work = File(ctx.cacheDir, "speech-work").apply { mkdirs() }
    private var n = 0

    override fun speech(text: String, voice: SpeechPlayer.Voice): SpeechPlayer.Pcm {
        val f = File(work, "p${(n++) % 4}.wav")
        recorder.record(text, voice.engine, voice.name, voice.pitch, voice.rate, f, 60)
        return SpeechPlayer.readWav(f.readBytes())
    }

    /** Spoken forms of the reactions (the engine says these naturally in most voices). */
    private val spoken = mapOf("mm-hmm" to "Mm-hmm.", "uh-huh" to "Uh-huh.", "hmm" to "Hmm.", "oh" to "Oh!", "right" to "Right.", "yeah" to "Yeah.", "ah" to "Ah.", "laugh" to "Ha ha!", "chuckle" to "Heh.")

    override fun clip(name: String, voice: SpeechPlayer.Voice): SpeechPlayer.Pcm? {
        // Breaths and sighs: shaped breath noise (a voice engine reading the word sounds wrong).
        if (name == "breath" || name == "sigh") return SpeechPlayer.breath(name, 24_000)
        val say = spoken[name] ?: return null
        val key = MessageDigest.getInstance("SHA-1").digest("${voice.engine}|${voice.name}|${voice.pitch}".toByteArray()).joinToString("") { "%02x".format(it) }.take(16)
        val f = File(ctx.cacheDir, "speech-clips/$key/$name.wav")
        if (!f.exists()) {
            f.parentFile?.mkdirs()
            runCatching { recorder.record(say, voice.engine, voice.name, voice.pitch, voice.rate, f, 30) }.onFailure { return null }
        }
        var p = runCatching { SpeechPlayer.trimSilence(SpeechPlayer.readWav(f.readBytes())) }.getOrNull() ?: return null
        // A laugh a little quicker and brighter than speech.
        if (name == "laugh" || name == "chuckle") p = SpeechPlayer.applySonic(p, 1.15f, 1.05f)
        // Longer than a short reaction (the engine read it oddly): leave it out.
        return if (p.samples.size > p.rate * 1.2) null else p
    }

    /** Makes the reactions ahead of time, so the first one plays without a wait. */
    fun warmClips(voice: SpeechPlayer.Voice) { for (k in spoken.keys) clip(k, voice) }
}

class AudioTrackSink(private val callMode: () -> Boolean) : SpeechPlayer.AudioSink {
    private var track: AudioTrack? = null
    private var trackRate = 0
    private var trackCall = false
    private val lock = Object()

    private fun trackFor(rate: Int): AudioTrack {
        val call = callMode()
        track?.let { if (trackRate == rate && trackCall == call) return it }
        track?.run { runCatching { stop() }; release() }
        val min = AudioTrack.getMinBufferSize(rate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
        val t = AudioTrack.Builder()
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(if (call) AudioAttributes.USAGE_VOICE_COMMUNICATION else AudioAttributes.USAGE_ASSISTANT)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
            )
            .setAudioFormat(AudioFormat.Builder().setSampleRate(rate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setBufferSizeInBytes(maxOf(min, rate / 5 * 2)) // ~100 ms: small, so stopping is quick
            .setTransferMode(AudioTrack.MODE_STREAM)
            .build()
        track = t
        trackRate = rate
        trackCall = call
        return t
    }

    override fun write(rate: Int, buf: ShortArray, off: Int, len: Int): Int {
        val t = synchronized(lock) { trackFor(rate).also { if (it.playState != AudioTrack.PLAYSTATE_PLAYING) it.play() } }
        return t.write(buf, off, len)
    }

    override fun stopNow() {
        synchronized(lock) { track?.run { runCatching { pause(); flush() } } }
    }
}
