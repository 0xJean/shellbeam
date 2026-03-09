package app.shellbeam

import android.net.wifi.WifiManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
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
    private val mainHandler = Handler(Looper.getMainLooper())
    private val nsdBridge = NsdBridge()
    private var webViewRef: WebView? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        acquireMulticastLock()
        setupNsd()
    }

    /**
     * Called by WryActivity.setWebView() after Tauri creates the RustWebView.
     * This is the correct moment to install the JS bridge — the WebView is
     * fully initialized and will not be recreated.
     */
    override fun onWebViewCreate(webView: WebView) {
        super.onWebViewCreate(webView)
        Log.i(TAG, "onWebViewCreate: installing NSD bridge on ${webView.javaClass.name}")
        webViewRef = webView
        webView.addJavascriptInterface(nsdBridge, "ShellBeamNSD")

        // Notify the frontend once the page is ready.
        // The bridge is available immediately after addJavascriptInterface,
        // but the frontend JS may not have loaded yet. Fire a custom event
        // after a short delay so the frontend can re-check.
        mainHandler.postDelayed({
            dispatchBridgeReady(webView)
        }, 1500)
        // Fire again a bit later in case the first one was too early
        mainHandler.postDelayed({
            dispatchBridgeReady(webView)
        }, 4000)
    }

    private fun dispatchBridgeReady(webView: WebView) {
        webView.post {
            webView.evaluateJavascript(
                "(function(){" +
                    "if(typeof window.ShellBeamNSD!=='undefined'){" +
                    "  window.dispatchEvent(new CustomEvent('shellbeam-nsd-ready'));" +
                    "}" +
                    "})()", null
            )
        }
    }

    override fun onDestroy() {
        mainHandler.removeCallbacksAndMessages(null)
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

        @JavascriptInterface
        fun getDeviceName(): String {
            return android.os.Build.MODEL ?: "Android"
        }

        @JavascriptInterface
        fun logToNative(message: String) {
            Log.i(TAG, "JS-LOG: $message")
        }
    }

    private fun emitDeviceFound(name: String, host: String, port: Int, deviceType: String) {
        val json = """{"name":"${esc(name)}","host":"${esc(host)}","port":$port,"deviceType":"${esc(deviceType)}"}"""
        val js = """
            (function() {
                try {
                    window.dispatchEvent(new CustomEvent('shellbeam-nsd-device', {
                        detail: $json
                    }));
                } catch(e) { console.warn('NSD emit error:', e); }
            })();
        """.trimIndent()
        runOnUiThread { webViewRef?.evaluateJavascript(js, null) }
    }

    private fun esc(s: String): String {
        return s.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
    }
}
