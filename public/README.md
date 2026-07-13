# Slate — realtime server

This connects the teacher dashboard and student workspace for real: live roster updates,
live drawing sync, lock/unlock, hints, and teacher annotation all travel over an actual
WebSocket connection between separate browsers/devices.

## What's genuinely connected

- **Creating a classroom** issues a real join code from the server.
- **A student joining** via that code shows up live in the teacher's Live Monitor — no refresh needed.
- **Drawing** on the student's board streams to the teacher's thumbnail and the "View & Annotate" modal in real time.
- **Lock / Unlock**, from a student's card or the modal, actually blocks/unblocks drawing on that student's real board.
- **Hints** sent from the teacher appear as a sticky note on the student's actual board.
- **Annotating** (drawing on a student's board from the modal) appears on the student's real board, and is merged in a way that won't erase anything the student draws while the modal is open.

## What's still local-only (by design, for this stage)

- **Assignments and Analytics** are still client-side mock data — they aren't wired to the realtime layer yet. That's a reasonable next stage once you're happy with the live-teaching loop.
- **No database** — everything lives in server memory. Restarting the server clears all classrooms and students. Fine for a pilot; swap the `Map()`s in `server.js` for a real database (Postgres, SQLite, etc.) when you're ready to persist across restarts.
- **No accounts/auth** — anyone with a join code can join a classroom, and there's no teacher login. Fine for a closed pilot with a small group; worth adding before wider use.
- **The original two-pane whiteboard demo** (the very first prototype) isn't connected — `teacher.html` and `student.html` are the real, connected pair now.

## Run it locally

```
npm install
npm start
```

Then open:
- **Teacher**: http://localhost:3001/teacher.html
- **Student**: create a classroom in the teacher view first, copy the invite link it shows you, and open that link (it'll look like `http://localhost:3001/student.html?code=XXXX-YYYY`) in another browser, another browser profile, or an incognito window so it's a separate session.

This works great for testing with two windows on your own computer. To actually have a
*different device* (a student's iPad, say) join, that device needs to reach this server
over the network — see below.

## Get it onto the real internet (so students can actually join)

Right now this only runs on your machine. To make it reachable from other devices, you need
to deploy it somewhere with a public URL. A few free/cheap options that work well for a small
Node.js + WebSocket app like this:

**Render.com** (probably the easiest)
1. Push this folder to a GitHub repo.
2. On Render: New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Deploy. Render gives you a URL like `https://your-app.onrender.com`.
5. Teacher goes to `https://your-app.onrender.com/teacher.html`; invite links it generates will point students to the same domain.

**Railway.app** or **Glitch.com** work similarly — push the code, point it at `npm start`, and you get a public URL.

A couple of things to know once it's deployed:
- Free tiers on Render/Railway often "sleep" after inactivity — the first request after a quiet period can take a few seconds to wake up. Fine for a classroom that's used regularly; worth knowing about for a cold start during a live lesson.
- Since there's no database yet, redeploying or the service restarting clears all classrooms. Recreate them before class.

## Project structure

```
server.js          — the realtime backend (Express + Socket.IO)
public/teacher.html — the teacher dashboard, now connected
public/student.html — the student workspace, now connected
```
