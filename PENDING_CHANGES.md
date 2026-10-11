# Pending changes

Requests logged here are not built yet. Say "build" to fold them into a new version
(version number goes up, CHANGELOG.md is updated, this list is cleared), and "push" to upload to GitHub.

Current released version: 0.3.0

11. Lower-quality variants on small tiles. When a channel is put on a small tile, prefer the provider's SD / low-bitrate version of the same channel (matched by name, as failover does) if one exists; otherwise use the channel as chosen. A per-tile "quality" choice in the tile menu (Auto / SD / as chosen) and a setting "Small tiles prefer SD". Cuts provider download and decode load. No transcoding.
12. Shared-screen composite stream. The server composes a saved multiview (up to 9 tiles, same layouts) into ONE video stream that weak devices just play. Encodes only while someone is watching and stops when the last viewer leaves. Output 720p default (480p / 720p / 1080p selectable), H.264 + AAC, aimed at 50-inch TVs and Google TV / Fire TV Stick 4K Max as the weakest clients. Encoder choice: Intel Quick Sync (VAAPI, preferred), AMD VAAPI, or software, with a Test button for the GPU path. Needs /dev/dri passed through to the container (Proxmox -> Docker host -> container) and the matching VA driver in the image.
13. Optional per-tile 480p transcode for channels with no SD variant. Hardware encode only (VAAPI), off by default, with a limit on simultaneous transcodes so the 6-core CPU is not overloaded.
