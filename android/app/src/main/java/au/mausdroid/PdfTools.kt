package au.mausdroid

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import java.io.File

/**
 * PDFs of the podcast's sources: finding which page a quote is on, and a
 * simple viewer that opens at that page with the quote highlighted (the
 * text search needs Android 15 or later; older phones open at page 1).
 */
object PdfTools {
    val canSearch get() = Build.VERSION.SDK_INT >= 35

    private fun <T> open(path: String, fn: (PdfRenderer) -> T): T {
        val fd = ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY)
        return fd.use { PdfRenderer(it).use(fn) }
    }

    /** The search words for a quote: its first few words (long quotes rarely match exactly across lines). */
    fun needle(quote: String) = quote.trim().split(Regex("\\s+")).take(6).joinToString(" ")

    /** For each quote, the 0-based page it's on, or -1. */
    fun findPages(path: String, quotes: List<String>): List<Int> {
        if (!canSearch) return quotes.map { -1 }
        return open(path) { r ->
            quotes.map { q ->
                val n = needle(q)
                if (n.isBlank()) -1 else (0 until r.pageCount).firstOrNull { i -> r.openPage(i).use { p -> p.searchText(n).isNotEmpty() } } ?: -1
            }
        }
    }

    fun pageCount(path: String) = open(path) { it.pageCount }
}

class PdfViewActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val path = intent.getStringExtra("path") ?: return finish()
        val target = intent.getIntExtra("page", 0)
        val quote = intent.getStringExtra("quote").orEmpty()
        title = intent.getStringExtra("title") ?: "Source"
        val col = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(60, 60, 60)) }
        val scroll = ScrollView(this).apply { addView(col) }
        setContentView(scroll)
        val width = resources.displayMetrics.widthPixels
        val views = mutableListOf<ImageView>()
        runCatching {
            ParcelFileDescriptor.open(File(path), ParcelFileDescriptor.MODE_READ_ONLY).use { fd ->
                PdfRenderer(fd).use { r ->
                    for (i in 0 until minOf(r.pageCount, 60)) r.openPage(i).use { p ->
                        val h = (p.height.toFloat() * width / p.width).toInt()
                        val bmp = Bitmap.createBitmap(width, h, Bitmap.Config.ARGB_8888)
                        bmp.eraseColor(Color.WHITE)
                        p.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
                        // The quote, highlighted where it is on the page.
                        if (i == target && quote.isNotBlank() && PdfTools.canSearch) {
                            val scale = width.toFloat() / p.width
                            val paint = Paint().apply { color = Color.argb(90, 255, 213, 0) }
                            val c = Canvas(bmp)
                            for (m in p.searchText(PdfTools.needle(quote)).take(3)) for (rc in m.bounds)
                                c.drawRect(rc.left * scale - 4, rc.top * scale - 4, rc.right * scale + 4, rc.bottom * scale + 4, paint)
                        }
                        val iv = ImageView(this).apply { setImageBitmap(bmp); adjustViewBounds = true; setPadding(0, 0, 0, 12) }
                        col.addView(iv)
                        views.add(iv)
                    }
                }
            }
        }.onFailure { android.widget.Toast.makeText(this, "Couldn't open the PDF: ${it.message}", android.widget.Toast.LENGTH_LONG).show(); finish(); return }
        scroll.post { views.getOrNull(target)?.let { scroll.scrollTo(0, it.top) } }
    }
}
