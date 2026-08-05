# Phase 6 (design): Teleconferencing — LiveKit readiness

> **Status: design, not an implementation plan.** This is the deliverable of
> Phase 5 Task E1. It says what to build, what it costs, and the two things that
> must be answered on real hardware before anyone commits. Turn it into a
> task-by-task plan once those are answered.

**Goal of the feature:** start an audio/video call from a channel, so a
conversation that outgrows text does not move to a different tool.

**Recommendation: self-hosted LiveKit** (Apache-2.0). Everything below was
checked against the official LiveKit and Apple/Ionic documentation on
2026-08-05; sources are listed at the end.

---

## Why LiveKit and not the alternatives

| Option | Verdict |
|---|---|
| **Self-hosted LiveKit (SFU)** | **Recommended.** Its auth model is *our* auth model: the server mints a short-lived JWT per participant, so `getVisibleChannel()` decides who joins. Official React components; official Swift/Android SDKs if the webview ever falls short. |
| Jitsi Meet, iframe embed | Cheapest to stand up, and a genuine fallback (see the decision point). But the iframe is its own auth world, room security leans on secrets in URLs, and styling/behaviour inside it is not ours. |
| Peer-to-peer WebRTC, no server | Fine for 1:1, collapses past ~3 participants — every client uploads its stream to every other. Given a call is expected to be a channel-wide huddle, this is a dead end. |
| A hosted SaaS (Twilio/Daily/Zoom SDK) | No infrastructure work, but per-minute pricing on internal chatter, and customer conversations would leave our tenancy. |

The deciding factor is authorization. LiveKit rooms are named by us and access
is granted by a token we sign, which means the platform's existing rule —
**invisible means 404** — extends to calls without a second permission system to
keep in sync.

## Architecture

```
Client (SPA or Capacitor webview)
  │  1. POST /api/channels/:id/call-token        ← our API, our auth
  │     → { token, url }                          (404 if the channel is invisible)
  │
  │  2. connect(url, token)                      ← straight to LiveKit
  ▼
LiveKit server (SFU)  ──── Redis (only if multi-node)
```

**Room naming.** `channel:<id>`. One room per channel, created implicitly on
first join. No room table, nothing to keep in sync, and a DM gets a call for free
because a DM *is* a channel.

**Token minting** (`livekit-server-sdk`, server-side only — the API secret must
never reach a client):

```ts
const at = new AccessToken(config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, {
  identity: `user:${userId}`,       // stable, so a reconnect is the same participant
  name: displayName,                 // what other participants see
  ttl: '15m',                        // matches our access-token lifetime
});
at.addGrant({ roomJoin: true, room: `channel:${channelId}` });
return { token: await at.toJwt(), url: config.LIVEKIT_URL };
```

Default TTL is 6 hours; 15 minutes is deliberate — it should expire on the same
clock as the session that issued it, and LiveKit keeps an already-joined
participant connected past expiry.

**The endpoint, in full** — this is the whole authorization story:

```ts
channelsRouter.post('/:id/call-token', async (req, res) => {
  const id = parseId(req.params.id);
  const isAdmin = req.auth!.role === 'admin';
  // Same guard as reading the channel: invisible -> 404, never a 403.
  await requireVisibleChannel(id, req.auth!.userId, isAdmin);
  // Membership to *join*, mirroring who may post: a visible public channel you
  // have not joined should not put you in its call.
  if (!isAdmin && !(await isChannelMember(id, req.auth!.userId))) {
    throw new AppError(404, 'not_found', 'Not found');
  }
  res.json(await mintCallToken(id, req.auth!.userId));
});
```

**Presence.** Do not build it. LiveKit already reports participants in a room,
and a second source of truth would drift. Announce a call *starting* over the
existing socket (`call:started` on `channel:<id>`) so people who are not looking
at the channel get told.

## What has to be built

Roughly, in order:

1. **Server:** `livekit-server-sdk`, four config variables (`LIVEKIT_URL`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, plus a feature flag), the token
   endpoint above, and its tests — invisible channel → 404, non-member → 404,
   member → a token whose decoded grant names exactly `channel:<id>`.
2. **Web:** `@livekit/components-react` + `livekit-client`. A call bar in the
   channel header, and a `<LiveKitRoom>` panel. These load in the chat chunk, so
   Phase 5's code splitting keeps them off the login path — check the bundle
   after, since `livekit-client` is not small.
3. **Native:** Info.plist usage strings, Android runtime permissions, and a
   verified device matrix (below).
4. **Ops:** the LiveKit deployment, which is the real cost — see below.

## Infrastructure cost, stated plainly

LiveKit self-hosting is not a container you forget about:

- A **domain with a real certificate** (self-signed will not do).
- **Ports:** 7880 signalling, 7881 TCP, **UDP 50000–60000** for media, TURN/TLS
  on 5349 (or 443 without a load balancer). The UDP range is the part that
  surprises people behind a corporate firewall or a restrictive security group.
- **TURN/TLS should be on.** It is embedded, and it is what gets calls working
  from behind corporate firewalls.
- **Redis** once there is more than one node; a single node does not need it.
- Scaling is **CPU and bandwidth** bound; Docker wants host networking for
  media.

For a company of this size, one compute-optimized instance with TURN/TLS enabled
is very likely enough. Size it after measuring one real call.

## The two open questions — answer these on hardware first

Everything above is desk work. These are not:

### 1. Does the Capacitor webview carry a call acceptably?

Verified from the docs: WKWebView supports `getUserMedia` from **iOS 14.3**,
requires `NSCameraUsageDescription` and `NSMicrophoneUsageDescription`, and
**before iOS 15 re-prompts on every `getUserMedia` call** even when permission
was already granted — which would be intolerable for a call button. iOS 15+ adds
an API to hold the grant. HTTPS is required.

So the matrix to fill in on **real devices** (a simulator will not answer this):

| | iOS 15+ | Android (recent) |
|---|---|---|
| Permission prompt appears once, not per call | ? | ? |
| Audio survives backgrounding / a phone call interrupting | ? | ? |
| Echo cancellation acceptable on speakerphone | ? | ? |
| Video at 2–4 participants without thermal throttling | ? | ? |

If the answers are poor, the native path is the **official LiveKit Swift/Android
SDK behind a Capacitor plugin** — more work, no webview limits. Decide this
before writing any UI, because it determines whether the call UI can be shared
with web at all.

### 2. Is a room-per-channel the right model?

Cheap to build, but it means a channel has exactly one call. If two pairs of
people in `#general` need separate conversations, they cannot. The alternative
(`channel:<id>:<uuid>`, several concurrent calls, a list in the UI) is more work
and only worth it if that actually happens. **Ask the team**, do not guess.

## Fallback decision point

If the device matrix comes back bad **and** an SDK-based native path is judged
too expensive: embed **Jitsi Meet** in an iframe, with the room name derived
server-side from the channel id and gated by the same endpoint above. Accept the
weaker auth story and the loss of UI control as the price of shipping. This is a
real fallback, not a threat — decide it deliberately at that point rather than
sliding into it.

## Explicitly out of scope for a first version

Recording/egress (LiveKit has a separate egress service, and recording internal
conversations is a policy question before a technical one), screen sharing beyond
what the components give for free, telephone dial-in, and live transcription.

---

## Sources (checked 2026-08-05)

- LiveKit self-hosting — deployment requirements, ports, Redis, TURN:
  <https://docs.livekit.io/home/self-hosting/deployment/>
- LiveKit authentication overview (tokens are minted on a backend):
  <https://docs.livekit.io/home/get-started/authentication/>
- `livekit-server-sdk` (Node) — `AccessToken`, grants, TTL default of 6h:
  <https://www.npmjs.com/package/livekit-server-sdk>,
  <https://github.com/livekit/node-sdks/blob/main/packages/livekit-server-sdk/README.md>
- LiveKit React components: <https://github.com/livekit/components-js>
- LiveKit server: <https://github.com/livekit/livekit>
- WKWebView `getUserMedia` support and per-call prompting:
  <https://developer.apple.com/forums/thread/134216>,
  <https://forum.ionicframework.com/t/webrtc-in-ios-14-3-iframe-wkwebview-external-resource/202088>
