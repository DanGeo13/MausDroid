package au.mausdroid

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Starts MausDroid's background service after the phone restarts or the app updates. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        EngineService.start(ctx)
    }
}
