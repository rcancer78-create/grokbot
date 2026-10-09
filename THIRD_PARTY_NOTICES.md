# Third-party references

`inference.mjs` adapts protobuf field mappings, the checksum algorithm and the
native tool schema workaround from [taowen/grokbot2api](https://github.com/taowen/grokbot2api),
commit `90a77bc575570da4482f91dfacfd1f659fd74cac`. The implementation here uses Node.js,
strict framing, in-memory credentials, explicit parameter validation and no silent
fallback to another provider. Native mode has offline protocol tests; a live
inference credential is still required for end-to-end verification.

MIT License

Copyright (c) 2026 Tao Wen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Additional projects examined, without copying implementation:

- [andreanjos/grokbot-headless](https://github.com/andreanjos/grokbot-headless):
  Linux supervisor of the official local executor, not a Windows API backend.
- [adam91holt/grokbot-sdk](https://github.com/adam91holt/grokbot-sdk): gateway and
  agent lifecycle reference; not a raw model inference API.

Runtime dependencies and their licenses are recorded by npm in `package-lock.json`
and the installed dependency packages. Ajv is used for draft-07 JSON Schema validation.
