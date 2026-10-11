# Pending changes

Requests logged here are not built yet. Say "build" to fold them into a new version
(version number goes up, CHANGELOG.md is updated, this list is cleared), and "push" to upload to GitHub.

Current released version: 0.3.0

11. Lower-quality variants on small tiles. When a channel is put on a small tile, prefer the provider's SD / low-bitrate version of the same channel (matched by name, as failover does) if one exists; otherwise use the channel as chosen. A per-tile "quality" choice in the tile menu (Auto / SD / as chosen) and a setting "Small tiles prefer SD". Cuts provider download and decode load. No transcoding.
