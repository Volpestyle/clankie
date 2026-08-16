# docs/adr/0094-a-render-that-outlives-the-turn-comes-back-to-the-room.md

Decision that asynchronous video generation is registered against its originating room and returns through a later service-owned notice turn when complete. The callback rechecks room/transport policy and keeps provider job state out of model-authored routing.
