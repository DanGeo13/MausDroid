package au.mausdroid

import android.speech.tts.TextToSpeech
import java.util.Locale

/**
 * Some voice engines (e.g. a multilingual Phonon build whose default language
 * is Portuguese) don't list the phone's exact language (en-AU) and quietly fall
 * back to their own default, reading English with the wrong pronunciation.
 * This picks a language the engine says it supports: the phone's, then the
 * same language elsewhere (British, US…), then plain English.
 */
object SpeechLang {
    fun choose(t: TextToSpeech, want: Locale = Locale.getDefault()): Locale? {
        val tries = listOf(want, Locale(want.language, "GB"), Locale(want.language, "US"), Locale(want.language), Locale.UK, Locale.US, Locale.ENGLISH).distinct()
        for (l in tries) {
            val r = runCatching { t.isLanguageAvailable(l) }.getOrDefault(TextToSpeech.LANG_NOT_SUPPORTED)
            if (r >= TextToSpeech.LANG_AVAILABLE) return l
        }
        return null
    }

    /** Sets the voice if given (and it exists), else a supported language. */
    fun apply(t: TextToSpeech, voiceName: String?) {
        val v = if (voiceName.isNullOrBlank()) null else runCatching { t.voices?.firstOrNull { it.name == voiceName } }.getOrNull()
        if (v != null) { t.voice = v; return }
        val l = choose(t)
        if (l != null) runCatching { t.language = l } else runCatching { t.language = Locale.getDefault() }
        // A language alone can still pick an odd default voice: prefer one of that language that works offline.
        val best = runCatching { t.voices?.filter { it.locale?.language == (l ?: Locale.getDefault()).language && !it.isNetworkConnectionRequired && it.features?.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) != true }?.minByOrNull { if (it.locale?.country == (l ?: Locale.getDefault()).country) 0 else 1 } }.getOrNull()
        if (best != null) runCatching { t.voice = best }
    }
}
