package app.shellbeam

import android.net.wifi.WifiManager
import android.os.Bundle
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
    companion object {
        private const val TAG = "ShellBeam"
    }

    private var multicastLock: WifiManager.MulticastLock? = null
    private var nsdHelper: NsdHelper? = null
    private var webViewReady = false

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        acquireMulticastLock()
        setupNsd()
        // Delay WebView setup to ensure Tauri has created it
        window.decorView.post { setupWebViewBridge() }
    }

    override fun onDestroy() {
        nsdHelper?.destroy()
        nsdHelper = null
        releaseMulticastLock()
        super.onDestroy()
    }

    private fun acquireMulticastLock() {
        try {
            val wifiManager = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
            multicastLock = wifiManager.createMulticastLock("shellbeam-mdns").apply {
                setReferenceCounted(true)
                acquire()
            }
            Log.i(TAG, "MulticastLock acquired")
        } catch (e: Exception) {
            Log.e(TAG, "MulticastLock failed: ${e.message}")
        }
    }

    private fun releaseMulticastLock() {
        try {
            multicastLock?.let { if (it.isHeld) it.release() }
            multicastLock = null
        } catch (_: Exception) {}
    }

    private fun setupNsd() {
        nsdHelper = NsdHelper(this).apply {
            onDeviceFound = { name, host, port, deviceType ->
                emitDeviceFound(name, host, port, deviceType)
            }
        }
    }

    /**
     * Find Tauri's WebView and add our JS interface bridge.
     * This allows the frontend to call NSD methods directly.
     */
    private fun setupWebViewBridge() {
        val webView = findWebView()
        if (webView == null) {
            Log.w(TAG, "WebView not found, retrying in 500ms")
            window.decorView.postDelayed({ setupWebViewBridge() }, 500)
            return
        }
        webView.addJavascriptInterface(NsdBridge(), "ShellBeamNSD")
        webViewReady = true
        Log.i(TAG, "WebView JS bridge installed (ShellBeamNSD)")
    }

    /**
     * JS interface exposed to WebView as window.ShellBeamNSD.
     * Frontend calls these methods to control NSD registration/discovery.
     */
    inner class NsdBridge {
        @JavascriptInterface
        fun registerService(port: Int, instanceName: String) {
            Log.i(TAG, "JS -> registerService: port=$port name=$instanceName")
            nsdHelper?.registerService(port, instanceName)
        }

        @JavascriptInterface
        fun unregisterService() {
            Log.i(TAG, "JS -> unregisterService")
            nsdHelper?.unregisterService()
        }

        @JavascriptInterface
        fun startDiscovery() {
            Log.i(TAG, "JS -> startDiscovery")
            nsdHelper?.startDiscovery()
        }

        @JavascriptInterface
        fun stopDiscovery() {
            Log.i(TAG, "JS -> stopDiscovery")
            nsdHelper?.stopDiscovery()
        }
    }

    /**
     * Emit a device-found event to the WebView as a CustomEvent.
     * The frontend listens for 'shellbeam-nsd-device' and bridges it
     * into the Tauri event system.
     */
    private fun emitDeviceFound(name: String, host: String, port: Int, deviceType: String) {
        val json = buildJsonString(name, host, port, deviceType)
        val js = """
            (function() {
                try {
                    window.dispatchEvent(new CustomEvent('shellbeam-nsd-device', {
                        detail: $json
                    }));
                } catch(e) { console.warn('NSD emit error:', e); }
            })();
        """.trimIndent()

        runOnUiThread {
            findWebView()?.evaluateJavascript(js, null)
        }
    }

    private fun buildJsonString(name: String, host: String, port: Int, deviceType: String): String {
        return """{"name":"${esc(name)}","host":"${esc(host)}","port":$port,"deviceType":"${esc(deviceType)}"}"""
    }

    private fun esc(s: String): String {
        return s.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
    }

    private fun findWebView(): WebView? {
        return findWebViewInView(window.decorView)
    }

    private fun findWebViewInView(view: android.view.View): WebView? {
        if (view is WebView) return view
        if (view is android.view.ViewGroup) {
            for (i in 0 until view.childCount) {
                val found = findWebViewInView(view.getChildAt(i))
                if (found != null) return found
            }
        }
        return null
    }
}
