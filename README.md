# companion-module-ubiquiti-unifi

Companion module for controlling UniFi network switches via the UniFi controller API.

## Features

- Power cycle POE ports
- Change POE mode (auto/passive/off) on individual ports
- Change POE mode for entire port profiles
- API Key-based authentication
- Support for multiple sites

## Requirements

- UniFi Network Application (Controller) version 9.x or higher
- API Key generated from Settings → Admins & Users → API Access

## API Architecture

This module uses a hybrid approach:
- **UniFi Network Integration API v1** - Authentication, device discovery, monitoring, power cycle actions
- **Legacy UniFi API** - Port configuration (POE mode changes)

This combination provides full functionality while using the modern authentication system.

## Installation

Module is included in Companion's module repository. For development:

```bash
yarn install
yarn format  # Format code using prettier
```

## Development

See `.github/copilot-instructions.md` for detailed architecture documentation and development guidelines.

## License

See LICENSE file.

## Support

For issues, please file a GitHub issue at https://github.com/bitfocus/companion-module-ubiquiti-unifi/issues

