package app.shellbeam

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.Inet4Address

/**
 * Android NSD (Network Service Discovery) helper for ShellBeam mDNS sync.
 *
 * Uses the system NsdManager API which works reliably on Android,
 * unlike userspace mDNS libraries that struggle with multicast restrictions.
 */
class NsdHelper(private val context: Context) {
    companion object {
        private const val TAG = "ShellBeam-NSD"
        private const val SERVICE_TYPE = "_shellbeam._tcp."
    }

    private val nsdManager: NsdManager by lazy {
        context.getSystemService(Context.NSD_SERVICE) as NsdManager
    }

    private var registrationListener: NsdManager.RegistrationListener? = null
    private var discoveryListener: NsdManager.DiscoveryListener? = null
    private var isDiscovering = false
    private var registeredServiceName: String? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    // Callback: (name, host, port, deviceType) -> Unit
    var onDeviceFound: ((String, String, Int, String) -> Unit)? = null

    /**
     * Register this device as a ShellBeam sync service on the local network.
     */
    fun registerService(port: Int, instanceName: String) {
        unregisterService()

        val serviceInfo = NsdServiceInfo().apply {
            serviceName = instanceName
            serviceType = SERVICE_TYPE
            setPort(port)
            setAttribute("dt", "phone")
        }

        registrationListener = object : NsdManager.RegistrationListener {
            override fun onServiceRegistered(info: NsdServiceInfo) {
                registeredServiceName = info.serviceName
                Log.i(TAG, "Service registered: ${info.serviceName} port=$port")
            }
            override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.e(TAG, "Registration failed: error=$errorCode")
            }
            override fun onServiceUnregistered(info: NsdServiceInfo) {
                Log.i(TAG, "Service unregistered: ${info.serviceName}")
            }
            override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.e(TAG, "Unregistration failed: error=$errorCode")
            }
        }

        try {
            nsdManager.registerService(serviceInfo, NsdManager.PROTOCOL_DNS_SD, registrationListener)
        } catch (e: Exception) {
            Log.e(TAG, "registerService exception: ${e.message}")
        }
    }

    fun unregisterService() {
        registrationListener?.let {
            try {
                nsdManager.unregisterService(it)
            } catch (_: Exception) {}
        }
        registrationListener = null
        registeredServiceName = null
    }

    /**
     * Start discovering ShellBeam services on the local network.
     */
    fun startDiscovery() {
        if (isDiscovering) {
            stopDiscovery()
            // Small delay to let NsdManager clean up
            Thread.sleep(100)
        }

        discoveryListener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {
                Log.i(TAG, "Discovery started: $serviceType")
                isDiscovering = true
            }
            override fun onDiscoveryStopped(serviceType: String) {
                Log.i(TAG, "Discovery stopped: $serviceType")
                isDiscovering = false
            }
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                Log.i(TAG, "Service found: ${serviceInfo.serviceName} type=${serviceInfo.serviceType}")
                // Skip our own service
                if (serviceInfo.serviceName == registeredServiceName) {
                    Log.d(TAG, "Skipping own service: ${serviceInfo.serviceName}")
                    return
                }
                resolveService(serviceInfo)
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) {
                Log.i(TAG, "Service lost: ${serviceInfo.serviceName}")
            }
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(TAG, "Start discovery failed: error=$errorCode")
                isDiscovering = false
            }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
                Log.e(TAG, "Stop discovery failed: error=$errorCode")
            }
        }

        try {
            nsdManager.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
        } catch (e: Exception) {
            Log.e(TAG, "discoverServices exception: ${e.message}")
        }
    }

    fun stopDiscovery() {
        if (!isDiscovering) return
        discoveryListener?.let {
            try {
                nsdManager.stopServiceDiscovery(it)
            } catch (_: Exception) {}
        }
        discoveryListener = null
        isDiscovering = false
    }

    private fun resolveService(serviceInfo: NsdServiceInfo) {
        nsdManager.resolveService(serviceInfo, object : NsdManager.ResolveListener {
            override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
                Log.e(TAG, "Resolve failed for ${info.serviceName}: error=$errorCode")
            }
            override fun onServiceResolved(info: NsdServiceInfo) {
                val host = info.host
                val port = info.port
                val name = info.serviceName

                // Extract device type from TXT record attributes
                val dt = info.attributes["dt"]?.let { String(it) } ?: "computer"

                // Only use IPv4 addresses, skip loopback and link-local
                val ipStr = when {
                    host is Inet4Address -> {
                        val addr = host.hostAddress ?: return
                        if (addr.startsWith("127.") || addr.startsWith("169.254.")) return
                        addr
                    }
                    else -> return
                }

                Log.i(TAG, "Resolved: name=$name host=$ipStr port=$port dt=$dt")
                onDeviceFound?.invoke(name, ipStr, port, dt)
            }
        })
    }

    fun destroy() {
        stopDiscovery()
        unregisterService()
    }
}
