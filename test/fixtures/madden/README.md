# Madden export fixtures

These are trimmed copies of the sample Madden franchise export payloads published in
[snallabot-service](https://github.com/snallabot/snallabot-service) (`docs/madden/api_data`),
regenerated with `node tools/make-fixtures.js <path>/docs/madden/api_data`.

Changes from the originals: only the fields HFL-NN reads are kept, rosters are merged into one
file (`rosters.json.gz`, keyed by team id), free agents are cut to the best 150 by overall, and
the one gamer tag in `leagueteams` is replaced with `SampleOwner`.

The payload shapes are exactly what the Madden Companion App and Snallabot's custom export POST
to `/:platform/:leagueId/...`, so the tests exercise the real format. Note that the samples come
from different points in a season: the schedules and stats are Week 1, the standings are from
Week 9 (`weekIndex` 8).

The original data is distributed under the MIT License:

```
MIT License

Copyright (c) 2024 snallabot

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
```
