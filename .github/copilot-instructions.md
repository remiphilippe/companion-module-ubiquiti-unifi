# Companion Module: Ubiquiti UniFi

## Architecture Overview

This is a **Companion module** that controls Ubiquiti UniFi network switches via the UniFi controller API. It's built on the `@companion-module/base` framework and uses ES modules (`"type": "module"` in package.json).

**Key Components:**
- [main.js](../main.js) - `UnifiInstance` class extends `InstanceBase`, manages controller connection, authentication, and API operations
- [actions.js](../actions.js) - Defines user-facing actions (POE cycle, POE mode changes) using Companion's action system
- [config.js](../config.js) - Configuration fields for controller connection (host, port, credentials, site)
- [upgrades.js](../upgrades.js) - Migration scripts for config schema changes between versions
- [companion/manifest.json](../companion/manifest.json) - Module metadata for Companion's module registry

**External Dependencies:**
- `node-unifi` - **LEGACY** UniFi controller API client (being replaced)
- `p-queue` - Serializes API operations (concurrency: 1) to prevent race conditions

## Migration to Official UniFi API

**Current State:** Module uses a **hybrid approach** combining the official UniFi Network Integration API (v1) with legacy UniFi API endpoints.

**Architecture:** 
- **Integration API v1** - Authentication (API Key), device discovery, monitoring, and power cycle actions
- **Legacy API** - Port configuration (POE mode enable/disable/auto, port profiles)

**Why Hybrid?** The Integration API v1 is read-only for port configuration. It provides `POWER_CYCLE` action (reboot) but cannot enable/disable POE or change modes. The legacy API endpoints still work with API Key authentication for write operations.

### Key API Differences

| Aspect | Integration API v1 | Legacy API |
|--------|-------------------|------------|
| **Base Path** | `/integration/v1/` | `/api/s/<SITE>/` |
| **Authentication** | API Key in header | API Key in header (same) |
| **Site ID** | UUID format | String name (`default`) |
| **Device ID** | UUID format | MAC address or `_id` |
| **Port Actions** | `POST /v1/sites/{siteId}/devices/{deviceId}/interfaces/ports/{portIdx}/actions` with `POWER_CYCLE` | N/A |
| **Port Config** | Read-only via device details | `PUT /api/s/<SITE>/rest/device/{deviceId}` with `port_overrides` |
| **Port Profiles** | Not exposed | `GET/PUT /api/s/<SITE>/rest/portconf` |

### Migration Status

✅ **Completed:**

1. **Authentication Migration**
   - Implemented API Key authentication with Bearer tokens
   - Removed username/password/2FA fields from config
   - Added upgrade script to migrate existing configs

2. **Site ID Resolution**
   - Implemented `getSiteUuid()` with filter-based discovery
   - Caches site UUID after first lookup
   - Supports both site name and direct UUID configuration

3. **Device Identification**
   - Implemented `getDeviceUuid()` for MAC→UUID mapping
   - Caches device mappings in `deviceMacToUuid` Map
   - `refreshDeviceList()` populates cache from Integration API
   - UI displays MACs, actions use UUIDs internally

4. **Power Cycle Action**
   - Implemented using Integration API v1
   - `POST /v1/sites/{siteId}/devices/{deviceId}/interfaces/ports/{portIdx}/actions`
   - Action body: `{ "action": "POWER_CYCLE" }`

5. **Port Configuration (Hybrid Approach)**
   - Implemented `legacyApiRequest()` for configuration endpoints
   - POE mode changes use legacy API `/api/s/<SITE>/rest/device/{deviceId}` with `port_overrides`
   - Port profile changes use legacy API `/api/s/<SITE>/rest/portconf`
   - Both endpoints authenticate with same API Key

6. **Error Handling**
   - Updated to handle Integration API error format
   - Legacy API responses unwrapped from `{meta, data}` structure
   - Comprehensive error logging throughout

### Implementation Notes

- **Hybrid API Usage**: Module uses Integration API v1 for discovery/monitoring and legacy API for configuration
- **No Session Management**: API Key authentication is stateless for both endpoints
- **UUID Caching**: Cache site UUID and device MAC→UUID mappings to avoid repeated lookups  
- **Legacy API Path**: `/api/s/<SITE>/rest/...` where `<SITE>` is site name (not UUID)
- **Device Discovery**: Integration API `/v1/sites/{siteId}/devices` returns UUIDs and MACs
- **Port Configuration**: Legacy API requires full device object with `port_overrides` array

## Implementation Patterns

### Dual API Client Pattern

The module maintains two separate API clients:

1. **Integration API Client** ([main.js:115-159](../main.js)): `apiRequest(method, path, body)`
   - Base URL: `https://{host}:{port}/integration{path}`
   - Authentication: `Authorization: Bearer {apiKey}`
   - Used for: Device discovery, monitoring, power cycle actions
   - Returns: Direct JSON response

2. **Legacy API Client** ([main.js:73-113](../main.js)): `legacyApiRequest(method, path, body)`
   - Base URL: `https://{host}:{port}/api{path}` (path includes `/s/<SITE>/`)
   - Authentication: `Authorization: Bearer {apiKey}` (same as Integration API)
   - Used for: Port configuration, port profiles
   - Returns: Unwrapped data from `{meta, data}` structure

Both clients support SSL verification bypass via `config.sslverify`.

### Resource Caching Pattern

To minimize API calls, the module caches frequently accessed resources:

- **Site UUID** ([main.js:161-189](../main.js)): `getSiteUuid()` discovers UUID from site name on first call, returns cached value on subsequent calls
- **Device MAC→UUID Map** ([main.js:191-203](../main.js)): `getDeviceUuid(macAddress)` returns cached UUID or triggers `refreshDeviceList()`
- **Device List** ([main.js:208-222](../main.js)): `refreshDeviceList()` populates cache from Integration API

Caches are cleared on `configUpdated()` to ensure fresh data after configuration changes.

### Action Queue Pattern

All actions use `self.queue.add()` ([actions.js:27-29](../actions.js)) to serialize requests. This prevents race conditions when multiple buttons trigger actions simultaneously. The queue has `concurrency: 1` ([main.js:11-13](../main.js)).

### Dynamic Dropdown Options

Actions use dynamically populated dropdowns that refresh after connection:
- `switchMacAddressOptions` - Loaded from Integration API `GET /v1/sites/{siteId}/devices` ([main.js:232-245](../main.js))
- `portProfileOptions` - Loaded from legacy API `GET /s/<SITE>/rest/portconf` ([main.js:250-259](../main.js))

Both support `allowCustom: true` for manual entry if device/profile doesn't appear in list.

### Port Configuration Pattern

Changing POE mode on a specific port requires:
1. Get device UUID from MAC address (Integration API)
2. Get device details including MAC from Integration API (to get MAC for legacy API)
3. Get full device config from legacy API using MAC address
4. Extract `_id` and `port_overrides` array
5. Modify or add port override for target port
6. PUT updated `port_overrides` back to legacy API

This is a full-device update ([main.js:307-341](../main.js)), not a single-port API call.

## Development Workflow

### Building & Testing
```bash
# Install dependencies
yarn install

# Format code (uses @companion-module/tools prettier config)
yarn format

# No test suite currently (package.json shows "no test specified")
```

### Module Loading in Companion
The module is loaded via [companion/manifest.json](../companion/manifest.json) which specifies:
- `runtime.entrypoint: "../main.js"` - Points to ES module entry
- `runtime.type: "node18"` - Node.js 18+ runtime requirement
- `legacyIds: ["unifi"]` - Migration path from old module ID

### Build Configuration
[build-config.cjs](../build-config.cjs) excludes `http-cookie-agent` and `tough-cookie` from bundling (marked as externals), likely because they're provided by Companion's runtime or cause bundling issues.

## Common Tasks

### Adding a New Action
1. Add action definition to `getActionDefinitions()` in [actions.js](../actions.js)
2. Define options with proper types (`dropdown`, `number`, `textinput`)
3. Wrap callback in `self.queue.add()` to serialize execution
4. Call instance method from [main.js](../main.js) to perform API operation
5. Add corresponding method to `UnifiInstance` class if needed

### Adding Configuration Fields
Add to array in [config.js](../config.js) `getConfigFields()`. Use types from `@companion-module/base`:
- `textinput` - For IPs, ports (with `Regex.PORT`), site names
- `checkbox` - For boolean flags like `sslverify`
- `static-text` - For documentation/warnings
- `number` - For numeric inputs (e.g., 2FA token)

Mark required fields with `required: true`.

### Config Schema Migrations
Add upgrade scripts to [upgrades.js](../upgrades.js) export array. Each script receives `(context, props)` and returns `{ updatedConfig, updatedActions, updatedFeedbacks }`. Example: adding `site: 'default'` to existing configs ([upgrades.js:7-25](../upgrades.js)).

## Known Issues & TODOs

- Connection check interval (30s) validates Integration API availability
- Port profiles loaded from legacy API on startup
- No test suite currently exists
- Both Integration and Legacy API paths use same API Key authentication

## Companion Module Conventions

- **Status Management**: Use `updateStatus()` with `InstanceStatus.Ok/Connecting/ConnectionFailure/Disconnected`
- **Logging**: Use `this.log(level, message)` not `console.log()` - levels: `info`, `warn`, `error`, `debug`
- **TypeScript Comments**: Use `// @ts-check` and JSDoc for type safety without TypeScript compilation
- **Action Callbacks**: Must be async functions that can throw errors
- **Config Updates**: Implement `configUpdated()` to handle live config changes without restart
