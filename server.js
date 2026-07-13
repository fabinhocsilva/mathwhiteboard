/* =========================================================
   Slate — realtime server with teacher & student auth
   ---------------------------------------------------------
   In-memory store. Restarting the server clears all data.
   Swap the Map()s for a real database when you're ready to
   persist sessions across restarts.
   ========================================================= */
const express = require('express');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const { Server } = require('socket.io');
const DATA_FILE = path.join(__dirname, 'slate-data.json');

const app    = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

/* ── helpers ── */
const uid     = () => crypto.randomUUID();
const genCode = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let a = '', b = '';
  for (let i = 0; i < 4; i++) { a += chars[Math.floor(Math.random()*chars.length)]; b += chars[Math.floor(Math.random()*chars.length)]; }
  return a + '-' + b;
};

/* ── Password hashing (Node built-in, no extra deps) ── */
function hashPw(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return salt + ':' + hash;
}
function checkPw(password, stored) {
  const [salt, hash] = stored.split(':');
  return crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    crypto.scryptSync(password, salt, 32)
  );
}

/* ── In-memory stores ── */
const teachers   = new Map(); // email   → { id, email, name, passwordHash }
const students   = new Map(); // username → { id, username, passwordHash, name, avatar, classroomCode }
const classrooms = new Map(); // code    → { code, name, teacherId, students: Map }
const sessions   = new Map(); // token   → { type:'teacher'|'student', id, username? }
const invitations = new Map(); // id → { id, teacherId, teacherName, studentUsername, classroomCode, classroomName, status, createdAt }

/* ── Persist to disk so student work survives server restarts ── */
function saveState(){
  try{
    const data={
      teachers:Array.from(teachers.values()).map(t=>({...t})),
      students:Array.from(students.values()).map(s=>({...s})),
      classrooms:Array.from(classrooms.values()).map(c=>({
        code:c.code,name:c.name,teacherId:c.teacherId,
        students:Array.from(c.students.values()).map(s=>(Object.assign({},s,{socketId:null,status:'offline',livePathId:null,objects:JSON.parse(JSON.stringify(s.objects||[],(k,v)=>k==='_imgEl'?undefined:v))})))
      })),
      invitations:Array.from(invitations.values()).map(i=>({...i}))
    };
    fs.writeFileSync(DATA_FILE,JSON.stringify(data));
  }catch(e){ console.warn('Save error:',e.message); }
}
function loadState(){
  if(!fs.existsSync(DATA_FILE)) return;
  try{
    const data=JSON.parse(fs.readFileSync(DATA_FILE,'utf8'));
    (data.teachers||[]).forEach(t=>teachers.set(t.email,t));
    (data.students||[]).forEach(s=>students.set(s.username,s));
    (data.classrooms||[]).forEach(c=>{
      const room={...c,students:new Map()};
      (c.students||[]).forEach(s=>room.students.set(s.id,{...s}));
      classrooms.set(c.code,room);
    });
    (data.invitations||[]).forEach(i=>invitations.set(i.id,i));
    console.log('State loaded —',teachers.size,'teachers,',students.size,'students,',classrooms.size,'classrooms');
  }catch(e){ console.warn('Load error:',e.message); }
}
loadState();
setInterval(saveState,30000); // save every 30s
process.on('SIGTERM',()=>{saveState();process.exit(0);});
process.on('SIGINT',()=>{saveState();process.exit(0);});

function makeToken(type, id, extra) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { type, id, ...extra });
  return token;
}
function getSession(token) { return sessions.get(token) || null; }

function summarize(room) {
  return {
    code: room.code, name: room.name,
    students: Array.from(room.students.values()).map(s => ({
      id: s.id, name: s.name, avatar: s.avatar,
      objects: s.objects, locked: s.locked, status: s.status,
      canvasWidth: s.canvasWidth, canvasHeight: s.canvasHeight, permissions: s.permissions
    }))
  };
}

/* ── REST endpoints for auth ── */

// Teacher register
app.post('/api/teacher/register', (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !password) return res.json({ ok: false, error: 'All fields required.' });
  if (password.length < 8)          return res.json({ ok: false, error: 'Password must be at least 8 characters.' });
  const key = email.trim().toLowerCase();
  if (teachers.has(key))            return res.json({ ok: false, error: 'An account with that email already exists.' });
  const teacher = { id: uid(), email: key, name: name.trim(), passwordHash: hashPw(password) };
  teachers.set(key, teacher);
  const token = makeToken('teacher', teacher.id);
  res.json({ ok: true, token, name: teacher.name, email: teacher.email });
});

// Teacher login
app.post('/api/teacher/login', (req, res) => {
  const { email, password } = req.body || {};
  const key = (email || '').trim().toLowerCase();
  const teacher = teachers.get(key);
  if (!teacher || !checkPw(password, teacher.passwordHash))
    return res.json({ ok: false, error: 'Incorrect email or password.' });
  const token = makeToken('teacher', teacher.id);
  res.json({ ok: true, token, name: teacher.name, email: teacher.email });
});

// Student login (via REST so credentials don't go through WebSocket)
app.post('/api/student/login', (req, res) => {
  const { username, password } = req.body || {};
  const key = (username || '').trim().toLowerCase();
  const student = students.get(key);
  if (!student || !checkPw(password, student.passwordHash))
    return res.json({ ok: false, error: 'Incorrect username or password.' });
  const token = makeToken('student', student.id, { username: key });
  res.json({ ok: true, token, name: student.name, avatar: student.avatar, classroomCode: student.classroomCode });
});

// Token check (for page-reload persistence)
app.post('/api/auth/me', (req, res) => {
  const { token } = req.body || {};
  const sess = getSession(token);
  if (!sess) return res.json({ ok: false });
  if (sess.type === 'teacher') {
    const t = Array.from(teachers.values()).find(x => x.id === sess.id);
    return res.json({ ok: true, type: 'teacher', name: t ? t.name : '' });
  }
  if (sess.type === 'student') {
    const s = students.get(sess.username);
    return res.json({ ok: true, type: 'student', name: s ? s.name : '', avatar: s ? s.avatar : '🙂', classroomCode: s ? s.classroomCode : null });
  }
  res.json({ ok: false });
});

/* ── Teacher: student account management (REST) ── */

function teacherFromReq(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const sess = getSession(token);
  if (!sess || sess.type !== 'teacher') return null;
  return Array.from(teachers.values()).find(t => t.id === sess.id) || null;
}

// List students
app.get('/api/students', (req, res) => {
  if (!teacherFromReq(req)) return res.status(401).json({ ok: false });
  const list = Array.from(students.values()).map(s => ({
    id: s.id, username: s.username, name: s.name, avatar: s.avatar, classroomCode: s.classroomCode
  }));
  res.json({ ok: true, students: list });
});

// Create student
app.post('/api/students', (req, res) => {
  if (!teacherFromReq(req)) return res.status(401).json({ ok: false });
  const { name, username, password, avatar, classroomCode } = req.body || {};
  if (!name || !username || !password) return res.json({ ok: false, error: 'name, username and password are required.' });
  if (password.length < 4)             return res.json({ ok: false, error: 'Password must be at least 4 characters.' });
  const key = username.trim().toLowerCase();
  if (students.has(key))               return res.json({ ok: false, error: 'That username is already taken.' });
  const student = { id: uid(), username: key, name: name.trim(), passwordHash: hashPw(password), avatar: avatar || '🙂', classroomCode: classroomCode || null };
  students.set(key, student);
  res.json({ ok: true, student: { id: student.id, username: student.username, name: student.name, avatar: student.avatar, classroomCode: student.classroomCode } });
});

// Update student password or classroom
app.patch('/api/students/:username', (req, res) => {
  if (!teacherFromReq(req)) return res.status(401).json({ ok: false });
  const s = students.get(req.params.username.toLowerCase());
  if (!s) return res.json({ ok: false, error: 'Student not found.' });
  const { password, classroomCode, avatar } = req.body || {};
  if (password) {
    if (password.length < 4) return res.json({ ok: false, error: 'Password must be at least 4 characters.' });
    s.passwordHash = hashPw(password);
  }
  if (classroomCode !== undefined) s.classroomCode = classroomCode;
  if (avatar)                      s.avatar = avatar;
  res.json({ ok: true });
});

// Delete student
app.delete('/api/students/:username', (req, res) => {
  if (!teacherFromReq(req)) return res.status(401).json({ ok: false });
  students.delete(req.params.username.toLowerCase());
  res.json({ ok: true });
});

/* ── Invitation endpoints ── */

// Teacher sends invitation to student
app.post('/api/invitations', (req, res) => {
  const teacher = teacherFromReq(req);
  if (!teacher) return res.status(401).json({ ok: false, error: 'Not authenticated.' });
  const { studentUsername, classroomCode } = req.body || {};
  const student = students.get((studentUsername || '').toLowerCase());
  if (!student) return res.json({ ok: false, error: 'Student not found.' });
  const room = classrooms.get(classroomCode);
  if (!room) return res.json({ ok: false, error: 'Classroom not found.' });
  // Prevent duplicate pending invites
  const dup = Array.from(invitations.values()).find(i =>
    i.studentUsername === student.username && i.classroomCode === classroomCode && i.status === 'pending'
  );
  if (dup) return res.json({ ok: false, error: 'An invitation to this classroom is already pending.' });
  const id = uid();
  invitations.set(id, {
    id, teacherId: teacher.id, teacherName: teacher.name,
    studentUsername: student.username, classroomCode, classroomName: room.name,
    status: 'pending', createdAt: Date.now()
  });
  res.json({ ok: true, inviteId: id });
});

// Teacher views sent invitations
app.get('/api/invitations/sent', (req, res) => {
  const teacher = teacherFromReq(req);
  if (!teacher) return res.status(401).json({ ok: false });
  const list = Array.from(invitations.values())
    .filter(i => i.teacherId === teacher.id)
    .map(i => ({ id: i.id, studentUsername: i.studentUsername, classroomCode: i.classroomCode, classroomName: i.classroomName, status: i.status }));
  res.json({ ok: true, invitations: list });
});

// Student views own invitations
app.get('/api/invitations/mine', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const sess = getSession(token);
  if (!sess || sess.type !== 'student') return res.status(401).json({ ok: false });
  const list = Array.from(invitations.values())
    .filter(i => i.studentUsername === sess.username && i.status === 'pending')
    .map(i => ({ id: i.id, teacherName: i.teacherName, classroomCode: i.classroomCode, classroomName: i.classroomName }));
  res.json({ ok: true, invitations: list });
});

// Student responds to invitation
app.patch('/api/invitations/:id', (req, res) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const sess = getSession(token);
  if (!sess || sess.type !== 'student') return res.status(401).json({ ok: false });
  const inv = invitations.get(req.params.id);
  if (!inv || inv.studentUsername !== sess.username) return res.status(403).json({ ok: false });
  const { status, permissions } = req.body || {};
  if (!['accepted', 'declined'].includes(status)) return res.json({ ok: false, error: 'Invalid status.' });
  inv.status = status;
  if (status === 'accepted') {
    const student = students.get(sess.username);
    if (student) {
      student.classroomCode = inv.classroomCode;
      if (permissions) student.permissions = permissions;
    }
    res.json({ ok: true, classroomCode: inv.classroomCode, classroomName: inv.classroomName });
  } else {
    res.json({ ok: true });
  }
});

// Teacher cancels a pending invitation
app.delete('/api/invitations/:id', (req, res) => {
  const teacher = teacherFromReq(req);
  if (!teacher) return res.status(401).json({ ok: false });
  const inv = invitations.get(req.params.id);
  if (!inv || inv.teacherId !== teacher.id) return res.status(403).json({ ok: false });
  invitations.delete(req.params.id);
  res.json({ ok: true });
});

/* ── Public whiteboard info (no auth required — just name from code) ── */
app.get('/api/whiteboard/:code', (req, res) => {
  const room = classrooms.get(req.params.code.toUpperCase());
  if (!room) return res.json({ ok: false, error: 'Not found.' });
  res.json({ ok: true, code: room.code, name: room.name });
});

/* ── WebSocket events ── */
io.on('connection', (socket) => {

  socket.on('classroom:create', ({ name, token }, cb) => {
    const sess = getSession(token);
    if (!sess || sess.type !== 'teacher') { cb && cb({ ok: false, error: 'Not authenticated.' }); return; }
    const code = genCode();
    classrooms.set(code, { id: uid(), name: name || 'Classroom', code, teacherId: sess.id, students: new Map() });
    socket.join('teacher:' + code);
    socket.data.role = 'teacher'; socket.data.teacherCode = code;
    cb && cb({ ok: true, code, name: name || 'Classroom' });
  });

  socket.on('classroom:teacherJoin', ({ code, token }, cb) => {
    const sess = getSession(token);
    if (!sess || sess.type !== 'teacher') { cb && cb({ ok: false, error: 'Not authenticated.' }); return; }
    const room = classrooms.get(code);
    if (!room) { cb && cb({ ok: false, error: 'No classroom with that code.' }); return; }
    socket.join('teacher:' + code);
    socket.data.role = 'teacher';
    cb && cb({ ok: true, ...summarize(room) });
  });

  socket.on('classroom:join', ({ code, token }, cb) => {
    const sess = token ? getSession(token) : null;
    if (token && (!sess || sess.type !== 'student')) { cb && cb({ ok: false, error: 'Please log in first.' }); return; }
    if (!sess && !token) { cb && cb({ ok: false, error: 'Please log in or use the quick join link.' }); return; }
    const room = classrooms.get(code);
    if (!room) { cb && cb({ ok: false, error: 'Classroom not found.' }); return; }
    const studentAccount = students.get(sess.username);
    const id = uid();
    const student = { id, name: studentAccount ? studentAccount.name : 'Student', avatar: studentAccount ? studentAccount.avatar : '🙂',
      objects: [], locked: false, status: 'active', canvasWidth: 1100, canvasHeight: 500, socketId: socket.id, permissions: {annotate:true,lock:true,editProfile:true} };
    room.students.set(id, student);
    socket.join('classroom:' + code);
    socket.data.role = 'student'; socket.data.code = code; socket.data.studentId = id;
    io.to('teacher:' + code).emit('roster:update', summarize(room));
    cb && cb({ ok: true, studentId: id, classroomName: room.name, code });
  });

  socket.on('classroom:regenerateCode', ({ oldCode, token }, cb) => {
    const sess = getSession(token);
    if (!sess || sess.type !== 'teacher') { cb && cb({ ok: false }); return; }
    const room = classrooms.get(oldCode);
    if (!room) { cb && cb({ ok: false }); return; }
    const newCode = genCode();
    classrooms.delete(oldCode); room.code = newCode; classrooms.set(newCode, room);
    io.sockets.sockets.forEach(s => { if (s.rooms.has('teacher:' + oldCode)) s.join('teacher:' + newCode); });
    cb && cb({ ok: true, code: newCode });
  });

  socket.on('student:sync', ({ objects, canvasWidth, canvasHeight }) => {
    const code = socket.data.code, id = socket.data.studentId;
    const room = classrooms.get(code); if (!room) return;
    const s = room.students.get(id);  if (!s)    return;
    s.objects = objects;
    if (canvasWidth)  s.canvasWidth  = canvasWidth;
    if (canvasHeight) s.canvasHeight = canvasHeight;
    s.status = s.locked ? 'locked' : 'active';
    io.to('teacher:' + code).emit('student:objects', { code, studentId: id, objects, canvasWidth: s.canvasWidth, canvasHeight: s.canvasHeight });
    // Debounced save: write to disk 5s after last sync (not on every sync — too frequent)
    clearTimeout(io._saveTimer);
    io._saveTimer = setTimeout(saveState, 2000); // save 2s after last write
  });

  socket.on('teacher:lock', ({ code, studentId, locked }) => {
    const room = classrooms.get(code); if (!room) return;
    const s = room.students.get(studentId); if (!s) return;
    if (locked && s.permissions && s.permissions.lock === false) return; // student revoked
    s.locked = locked; s.status = locked ? 'locked' : 'active';
    io.to(s.socketId).emit('teacher:command', { type: 'lock', locked });
    io.to('teacher:' + code).emit('roster:update', summarize(room));
  });

  socket.on('teacher:annotate', ({ code, studentId, objects }) => {
    const room = classrooms.get(code); if (!room) return;
    const s = room.students.get(studentId); if (!s) return;
    if (s.permissions && s.permissions.annotate === false) return; // student revoked
    s.objects = objects;
    io.to(s.socketId).emit('teacher:command', { type: 'objects', objects });
    io.to('teacher:' + code).emit('student:objects', { code, studentId, objects });
  });

  socket.on('teacher:hint', ({ code, studentId, text }) => {
    const room = classrooms.get(code); if (!room) return;
    const s = room.students.get(studentId); if (!s) return;
    io.to(s.socketId).emit('teacher:command', { type: 'hint', text });
  });

  socket.on('student:permissions', ({ studentId, code, permissions }) => {
    const room = classrooms.get(code); if (!room) return;
    const s = room.students.get(studentId); if (!s) return;
    s.permissions = permissions;
    io.to('teacher:' + code).emit('roster:update', summarize(room));
  });

  // Respect student permissions on annotate + lock
  /* ── stroke:live relay: teacher sees student drawing at ~60fps ── */
  socket.on('stroke:live', (data)=>{
    const code=socket.data.code;
    if(!code||socket.data.role!=='student') return;
    io.to('teacher:'+code).emit('stroke:live',{
      ...data, studentId:socket.data.studentId, code
    });
  });

  /* ── teacher:stroke:live relay: student sees teacher annotating at ~60fps ── */
  socket.on('teacher:stroke:live', (data)=>{
    const { studentId, code, pathId, points, color, width, owner } = data;
    const room = classrooms.get(code);
    if(!room) return;
    const student = room.students.get(studentId);
    if(!student || !student.socketId) return;
    io.to(student.socketId).emit('teacher:stroke:live', { pathId, points, color, width, owner:'teacher' });
  });

  /* ── Quick join: student opens share link, enters just their name ── */
  socket.on('whiteboard:quickjoin', ({code, name, sessionKey}, cb)=>{
    const room=classrooms.get(code);
    if(!room){cb&&cb({ok:false,error:'Whiteboard not found. Check the link and try again.'});return;}
    name=(name||'').trim();
    if(!name){cb&&cb({ok:false,error:'Please enter your name.'});return;}
    // Reconnect: if same sessionKey seen before, restore their work
    let student=sessionKey ? Array.from(room.students.values()).find(s=>s.sessionKey===sessionKey) : null;
    // Also try matching by name (for browser reload without sessionKey)
    if(!student) student=Array.from(room.students.values()).find(s=>s.name===name&&!s.socketId);
    if(!student){
      const id=uid();
      student={id,name,avatar:'🙂',sessionKey:sessionKey||uid(),
        objects:[],locked:false,status:'active',canvasWidth:1100,canvasHeight:500,
        socketId:socket.id,permissions:{annotate:true,lock:true,editProfile:true},isGuest:true};
      room.students.set(id,student);
    } else {
      student.status='active'; student.socketId=socket.id;
      if(sessionKey) student.sessionKey=sessionKey;
    }
    socket.join('classroom:'+code);
    socket.data.role='student'; socket.data.code=code; socket.data.studentId=student.id;
    io.to('teacher:'+code).emit('roster:update',summarize(room));
    cb&&cb({ok:true,studentId:student.id,classroomName:room.name,code,
            sessionKey:student.sessionKey,objects:student.objects||[]});
  });

  socket.on('disconnect', () => {
    if (socket.data.role === 'student' && socket.data.code) {
      const room = classrooms.get(socket.data.code);
      if (room) {
        const s = room.students.get(socket.data.studentId);
        if (s) { s.status = 'offline'; io.to('teacher:' + socket.data.code).emit('roster:update', summarize(room)); }
      }
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => console.log('Slate server listening on :' + PORT));
