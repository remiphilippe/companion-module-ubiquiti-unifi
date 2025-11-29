## Ubiquiti UniFi

This module will allow you to control UniFi network switches via the official UniFi Network Integration API.

### Configuration
* Enter the IP Address of the UniFi controller.
* Enter the port of the UniFi controller (default: 8443).
* Generate an API Key in the UniFi Network application under Settings → Admins & Users → API Access.
* Enter the API Key. NOTE: This will be stored in clear text within the Companion config.
* Enter the Site Name (default: 'default') or optionally provide the Site UUID directly.

### To use the module
Add an action to a button and choose the action you wish to use.
NOTE: Commands may not be executed immediately if a large number of update actions are stacked.

**Available actions:**
* Power Cycle POE Switchport - Cycles power on a specific switch port (reboots connected device)
* Switchport POE Mode - Set POE mode (auto/passive/off) on a specific port
* Profile POE Mode - Set POE mode for an entire port profile

### Technical Notes
This module uses a hybrid approach:
- **Integration API v1** - For authentication, device discovery, and monitoring
- **Legacy UniFi API** - For port configuration (POE mode changes)

This combination provides full functionality while using the modern authentication system.
