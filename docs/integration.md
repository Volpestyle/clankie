# Approved commit integration (retired)

The service's integrate queue is gone. Every change to Clankie's repositories
lands through a pull request that merges once its checks and real-app run are
green ([ADR 0332](adr/0332-clankies-own-pull-requests-merge-on-green-checks.md)).
Deploy holds moved to `clankie update holds|hold|release`; see
[deploy holds](deploy-holds.md). This page stays only so older records that link
here still resolve.
