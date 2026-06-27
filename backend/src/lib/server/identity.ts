import os from 'os';

/**
 * Retrieves the primary MAC address of the host machine to use as a unique device identifier.
 */
export function getMacAddress(): string {
	const interfaces = os.networkInterfaces();
	
	for (const name of Object.keys(interfaces)) {
		const ifaceList = interfaces[name];
		if (!ifaceList) continue;
		
		for (const iface of ifaceList) {
			// Skip internal interfaces (loopback) and invalid MAC addresses
			if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
				return iface.mac;
			}
		}
	}
	
	// Fallback if no network interface is found
	return 'unknown-device';
}
