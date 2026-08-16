# packages/media-connector/test/media-connector.test.ts

Suite built on a `recorder()` fake fetch that
captures url/headers/body and returns a canned
response. Covers: schema validation (v2 accepted,
v1 refused, video-only fields bounded, image-only
fields rejected on video); per-provider request
shaping (OpenAI bearer + output_format, Google
key-in-header not URL, Grok aspect_ratio +
b64_json); artifact hashing and bytes written;
pixel-art path refusal before any provider call;
edit-vs-generate endpoint routing keyed on
`sourceImage`; and the video job flow — start
returns a pending job, retrieve refuses not-done
jobs and foreign hosts, and a finished render is
downloaded, hashed, and written.
