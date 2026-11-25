package au.mausdroid

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The bots' browser. Pages load in off-screen WebViews inside the
 * background service, so they keep working while you use the phone or the
 * screen is off. Logins (cookies) are shared with the sign-in screen, so
 * you log in once yourself and the bots stay logged in.
 */
class BackgroundBrowser(private val ctx: Context) {
    private val main = Handler(Looper.getMainLooper())
    private val tabs = LinkedHashMap<String, Tab>()

    private class Tab(val view: WebView) {
        @Volatile var loading = false
        @Volatile var lastFinished = 0L
    }

    init {
        WebView.enableSlowWholeDocumentDraw()
        CookieManager.getInstance().setAcceptCookie(true)
    }

    private fun <T> onMain(timeoutSec: Long = 60, block: (done: (T) -> Unit) -> Unit): T {
        val latch = CountDownLatch(1)
        var result: T? = null
        main.post { block { r -> result = r; latch.countDown() } }
        if (!latch.await(timeoutSec, TimeUnit.SECONDS)) throw RuntimeException("The browser took too long")
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun newTab(): Pair<String, Tab> = onMain { done ->
        val v = WebView(ctx)
        v.settings.javaScriptEnabled = true
        v.settings.domStorageEnabled = true
        v.settings.loadWithOverviewMode = true
        v.settings.useWideViewPort = true
        v.settings.mediaPlaybackRequiresUserGesture = true
        v.setLayerType(View.LAYER_TYPE_SOFTWARE, null)
        CookieManager.getInstance().setAcceptThirdPartyCookies(v, true)
        val tab = Tab(v)
        v.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) { tab.loading = true }
            override fun onPageFinished(view: WebView, url: String?) { tab.loading = false; tab.lastFinished = System.currentTimeMillis() }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val s = request.url.scheme ?: return true
                return !(s == "http" || s == "https") // never open other apps from the bot's browser
            }
        }
        // A real phone-sized page so sites lay out normally.
        v.measure(View.MeasureSpec.makeMeasureSpec(1080, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(2200, View.MeasureSpec.EXACTLY))
        v.layout(0, 0, 1080, 2200)
        v.resumeTimers()
        val id = "t" + UUID.randomUUID().toString().take(6)
        tabs[id] = tab
        while (tabs.size > 6) tabs.remove(tabs.keys.first())?.view?.destroy()
        done(id to tab)
    }

    private fun tab(id: String?): Tab = tabs[id] ?: throw IllegalArgumentException("No tab $id (it may have closed). Open the page again.")

    private fun waitSettled(t: Tab, maxMs: Long = 30_000) {
        val start = System.currentTimeMillis()
        Thread.sleep(400)
        while (System.currentTimeMillis() - start < maxMs) {
            if (!t.loading && System.currentTimeMillis() - t.lastFinished > 900) return
            Thread.sleep(250)
        }
    }

    private fun eval(t: Tab, js: String): String {
        val raw: String = onMain { done -> t.view.evaluateJavascript(js) { done(it ?: "null") } }
        // evaluateJavascript returns a JSON-encoded value.
        return if (raw.startsWith("\"")) JSONArray("[$raw]").getString(0) else raw
    }

    private val readJs = """
        (function(mode){
          function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;}
          if(mode==='links'){return Array.from(document.querySelectorAll('a[href]')).filter(vis).slice(0,150).map(function(a){return (a.innerText||a.title||'').trim().slice(0,80)+' -> '+a.href;}).join('\n');}
          if(mode==='forms'){var out=[];var i=0;document.querySelectorAll('input,textarea,select,button,[role=button],a.btn').forEach(function(e){if(!vis(e))return;var sel=e.id?'#'+CSS.escape(e.id):(e.name?e.tagName.toLowerCase()+'[name="'+e.name+'"]':null);if(!sel){e.setAttribute('data-md',String(++i));sel='[data-md="'+i+'"]';}out.push(e.tagName.toLowerCase()+(e.type?'['+e.type+']':'')+' '+sel+' '+((e.labels&&e.labels[0]&&e.labels[0].innerText)||e.placeholder||e.innerText||e.value||e.getAttribute('aria-label')||'').trim().slice(0,60));});return out.slice(0,200).join('\n');}
          var t=document.body?document.body.innerText:'';return t.slice(0,30000);
        })('MODE')
    """.trimIndent()

    private fun pageInfo(t: Tab, withText: Boolean = true): JSONObject {
        val o = JSONObject()
        val info: Pair<String, String> = onMain { done -> done((t.view.url ?: "") to (t.view.title ?: "")) }
        o.put("url", info.first).put("title", info.second)
        if (withText) o.put("text", eval(t, readJs.replace("MODE", "text")))
        return o
    }

    fun open(url: String, tabId: String?): JSONObject {
        val (id, t) = if (tabId != null && tabs.containsKey(tabId)) tabId to tab(tabId) else newTab()
        onMain<Unit> { done -> t.loading = true; t.view.loadUrl(url); done(Unit) }
        waitSettled(t)
        return pageInfo(t).put("tab", id)
    }

    fun read(tabId: String, mode: String): JSONObject =
        JSONObject().put("text", eval(tab(tabId), readJs.replace("MODE", if (mode in listOf("links", "forms")) mode else "text")))

    fun click(tabId: String, selector: String?, text: String?): JSONObject {
        val t = tab(tabId)
        val js = """
            (function(sel,txt){
              var el=null;
              if(sel){el=document.querySelector(sel);}
              if(!el&&txt){var all=document.querySelectorAll('a,button,input[type=submit],input[type=button],[role=button],[onclick],label,summary,li,span,div');
                for(var i=0;i<all.length;i++){var e=all[i];var s=(e.innerText||e.value||e.getAttribute('aria-label')||'').trim();if(s&&s.toLowerCase()===txt.toLowerCase()){el=e;break;}}
                if(!el){for(var j=0;j<all.length;j++){var e2=all[j];var s2=(e2.innerText||e2.value||'').trim();if(s2&&s2.toLowerCase().indexOf(txt.toLowerCase())>=0&&s2.length<200){el=e2;break;}}}}
              if(!el)return 'Not found';
              el.scrollIntoView({block:'center'});el.click();return 'Clicked '+(el.innerText||el.value||el.tagName).trim().slice(0,60);
            })(${JSONObject.quote(selector ?: "")},${JSONObject.quote(text ?: "")})
        """.trimIndent()
        val r = eval(t, js)
        waitSettled(t, 20_000)
        return pageInfo(t).put("result", r)
    }

    fun type(tabId: String, selector: String, text: String, submit: Boolean): JSONObject {
        val t = tab(tabId)
        val js = """
            (function(sel,val,submit){
              var el=document.querySelector(sel); if(!el) return 'Not found';
              el.focus();
              var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
              var setter=Object.getOwnPropertyDescriptor(proto,'value');
              if(setter&&setter.set){setter.set.call(el,val);}else{el.value=val;}
              el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));
              if(submit){
                el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,bubbles:true}));
                if(el.form){ if(el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); }
              }
              return 'Typed into '+sel;
            })(${JSONObject.quote(selector)},${JSONObject.quote(text)},$submit)
        """.trimIndent()
        val r = eval(t, js)
        waitSettled(t, if (submit) 20_000 else 2_000)
        return pageInfo(t).put("result", r)
    }

    fun scroll(tabId: String, down: Boolean): JSONObject {
        val t = tab(tabId)
        eval(t, "window.scrollBy(0, ${if (down) 1 else -1} * window.innerHeight * 0.9); 'ok'")
        Thread.sleep(600)
        val visible = eval(t, "(function(){var out=[];var h=window.innerHeight;document.querySelectorAll('p,li,h1,h2,h3,h4,td,a,span,div').forEach(function(e){if(e.children.length>2)return;var r=e.getBoundingClientRect();if(r.top>=0&&r.top<h&&e.innerText){out.push(e.innerText.trim());}});return Array.from(new Set(out)).join('\\n').slice(0,15000);})()")
        return JSONObject().put("text", visible)
    }

    fun screenshot(tabId: String): JSONObject {
        val t = tab(tabId)
        val jpeg: String = onMain { done ->
            val bmp = Bitmap.createBitmap(1080, 2200, Bitmap.Config.RGB_565)
            t.view.draw(Canvas(bmp))
            val scaled = Bitmap.createScaledBitmap(bmp, 540, 1100, true)
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, 70, out)
            done(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP))
        }
        return pageInfo(t, false).put("jpeg", jpeg)
    }

    fun close(tabId: String) {
        onMain<Unit> { done -> tabs.remove(tabId)?.view?.destroy(); done(Unit) }
    }

    fun list(): JSONArray = onMain { done ->
        val a = JSONArray()
        for ((id, t) in tabs) a.put(JSONObject().put("tab", id).put("url", t.view.url).put("title", t.view.title))
        done(a)
    }
}
