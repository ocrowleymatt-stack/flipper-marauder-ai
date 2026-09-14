# @atlas-vnext/permissions

Platform primitive: capability-based permissions.

Scopes such as `filesystem.read`, `shell.execute`, and `device.control` are evaluated here. UI code and dungeons must not scatter ad-hoc permission checks.

This package is a design-gate shell. Grant persistence is deferred; the interface is the contract.
