/*
 * หน้าสแกนเช็คชื่อ (รันบน GitHub Pages)
 * คุยกับ Google Apps Script ผ่าน fetch (POST, text/plain เพื่อเลี่ยง CORS preflight)
 */
(function () {
  "use strict";

  var CFG = window.APP_CONFIG || {};
  var MODEL_URL = "https://cdn.jsdelivr.net/npm/@vladmandic/face-api/model";

  var S = {
    pin: localStorage.getItem("scan_pin") || "",
    adminPin: sessionStorage.getItem("admin_pin") || "",
    info: null,          // ข้อมูลจาก action init
    offset: 0,           // เวลาเซิร์ฟเวอร์ - เวลาเครื่อง
    tab: "face",
    stream: null,
    running: false,
    timer: null,
    qr: null,
    modelsReady: false,
    db: [],              // ฐานข้อมูลใบหน้า {id, name, desc:Float32Array}
    busy: false,
    hold: {},            // code -> เวลาที่ห้ามส่งซ้ำจนถึง
    lastMissAt: 0,
    people: [],
    shots: [],
    wake: null
  };
  var gateCb = null, gateCancelCb = null;

  /* ---------------- helpers ---------------- */
  function $(id) { return document.getElementById(id); }

  function say(id, text, cls) {
    var el = $(id);
    el.className = "msg " + cls;
    el.textContent = text;
  }

  function errText(e) {
    if (!e) return "เกิดข้อผิดพลาด";
    if (typeof e === "string") return /Permission|NotAllowed/i.test(e) ? "ไม่ได้รับอนุญาตใช้กล้อง — กดอนุญาตที่แถบที่อยู่เว็บ" : e;
    if (e.name === "NotAllowedError") return "ไม่ได้รับอนุญาตใช้กล้อง — กดอนุญาตที่แถบที่อยู่เว็บ แล้วลองใหม่";
    if (e.name === "NotFoundError" || e.name === "OverconstrainedError") return "ไม่พบกล้องที่เลือก ลองสลับกล้องหน้า/หลัง";
    if (e.name === "NotReadableError") return "กล้องถูกใช้งานโดยแอปอื่นอยู่";
    if (e.name === "TypeError" && /fetch|network/i.test(e.message || "")) {
      return "เชื่อมต่อ Google Apps Script ไม่ได้ — ตรวจอินเทอร์เน็ต และตรวจว่า Deploy เป็น \"Anyone\"";
    }
    return e.message || String(e);
  }

  function beep(ok) {
    try {
      var c = new (window.AudioContext || window.webkitAudioContext)();
      var o = c.createOscillator();
      o.connect(c.destination);
      o.frequency.value = ok ? 880 : 220;
      o.start();
      setTimeout(function () { o.stop(); c.close(); }, ok ? 120 : 320);
    } catch (e) { /* เงียบไว้ */ }
  }

  function keepAwake() {
    try {
      if (navigator.wakeLock && !S.wake) {
        navigator.wakeLock.request("screen").then(function (w) {
          S.wake = w;
          w.addEventListener("release", function () { S.wake = null; });
        }).catch(function () {});
      }
    } catch (e) { /* ไม่รองรับก็ข้าม */ }
  }

  function statusClass(st) {
    return st === "มา" ? "ok" : st === "สาย" ? "late" : st === "ลา" ? "leave" : "bad";
  }

  /* ---------------- เรียก GAS ---------------- */
  function api(action, args, needAdmin) {
    var body = { action: action, pin: S.pin, args: args || {} };
    if (needAdmin) body.adminPin = S.adminPin;
    return fetch(CFG.GAS_URL, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j.ok) {
          var e = new Error(j.msg || "เกิดข้อผิดพลาด");
          e.code = j.code || "";
          throw e;
        }
        return j.data;
      });
  }

  /* ---------------- กรอก PIN ---------------- */
  function ask(title, hint, cb, cancelCb) {
    gateCb = cb;
    gateCancelCb = cancelCb || null;
    $("gateTitle").textContent = title;
    $("gateHint").textContent = hint || "";
    $("gateMsg").textContent = "";
    $("gatePin").value = "";
    $("gateCancel").hidden = !cancelCb;
    $("gate").hidden = false;
    setTimeout(function () { $("gatePin").focus(); }, 50);
  }

  $("gateForm").addEventListener("submit", function (ev) {
    ev.preventDefault();
    var v = $("gatePin").value.trim();
    if (!v) return;
    $("gate").hidden = true;
    if (gateCb) gateCb(v);
  });
  $("gateCancel").addEventListener("click", function () {
    $("gate").hidden = true;
    if (gateCancelCb) gateCancelCb();
  });

  function askScanPin(msg) {
    ask("ใส่ PIN เครื่องสแกน", "รับ PIN ได้จากผู้ดูแลระบบ (ชีต Settings คีย์ SCAN_PIN)", function (v) {
      S.pin = v;
      localStorage.setItem("scan_pin", v);
      connect();
    });
    if (msg) $("gateMsg").textContent = msg;
  }

  function askAdminPin(msg) {
    ask("ใส่รหัสลงทะเบียนใบหน้า", "สำหรับผู้ดูแลเท่านั้น (ชีต Settings คีย์ ENROLL_PIN)", function (v) {
      S.adminPin = v;
      sessionStorage.setItem("admin_pin", v);
      loadPeople().catch(adminErr);
    }, function () { setTab("face"); });
    if (msg) $("gateMsg").textContent = msg;
  }

  function adminErr(e) {
    if (e.code === "BAD_ADMIN") {
      S.adminPin = "";
      sessionStorage.removeItem("admin_pin");
      askAdminPin(e.message);
    } else if (e.code === "BAD_PIN") {
      S.pin = "";
      localStorage.removeItem("scan_pin");
      askScanPin(e.message);
    } else {
      say("eMsg", errText(e), "err");
    }
  }

  /* ---------------- เริ่มต้น ---------------- */
  function fatal(msg) {
    var f = $("fatal");
    f.textContent = msg;
    f.hidden = false;
    $("dateTxt").textContent = "เชื่อมต่อไม่สำเร็จ";
  }

  function connect() {
    $("dateTxt").textContent = "กำลังเชื่อมต่อ...";
    api("init").then(function (info) {
      S.info = info;
      S.offset = (info.now || Date.now()) - Date.now();
      $("fatal").hidden = true;
      $("orgName").textContent = info.org || "ระบบสแกนเช็คชื่อเข้าแถว";
      if (info.logo) { $("logo").src = info.logo; $("logo").hidden = false; }
      tick();
      setInterval(tick, 1000);
      setTab("face");
    }).catch(function (e) {
      if (e.code === "BAD_PIN") {
        S.pin = "";
        localStorage.removeItem("scan_pin");
        askScanPin(e.message);
      } else {
        fatal(e.code === "NO_PIN" ? e.message : "เชื่อมต่อระบบไม่ได้: " + errText(e));
      }
    });
  }

  var clockTimer = null;
  function tick() {
    if (!S.info) return;
    var d = new Date(Date.now() + S.offset);
    var tz = S.info.tz || "Asia/Bangkok";
    $("clock").textContent = d.toLocaleTimeString("th-TH", { timeZone: tz, hour12: false });
    $("dateTxt").textContent = d.toLocaleDateString("th-TH", {
      timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric"
    });
  }

  /* ---------------- แท็บ ---------------- */
  function setTab(t) {
    if (!S.info) return;
    stopAll();
    S.hold = {};
    S.tab = t;
    document.body.dataset.tab = t;
    document.querySelectorAll("#tabs button").forEach(function (b) { b.classList.toggle("on", b.dataset.tab === t); });
    document.querySelectorAll(".panel").forEach(function (p) { p.classList.toggle("on", p.id === "tab-" + t); });
    if (t === "face") $("camSel").value = "user";
    if (t === "qr") $("camSel").value = "environment";
    if (t === "enroll") {
      if (S.adminPin) loadPeople().catch(adminErr);
      else askAdminPin();
    }
  }

  document.querySelectorAll("#tabs button").forEach(function (b) {
    b.addEventListener("click", function () { setTab(b.dataset.tab); });
  });

  /* ---------------- กล้อง ---------------- */
  function openCamera(video) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return Promise.reject(new Error("เบราว์เซอร์นี้เปิดกล้องไม่ได้ (ต้องเปิดผ่าน https)"));
    }
    var facing = $("camSel").value;
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: facing, width: { ideal: 640 }, height: { ideal: 480 } }
    }).then(function (stream) {
      S.stream = stream;
      video.srcObject = stream;
      video.classList.toggle("mirror", facing === "user");
      video.parentNode.classList.add("live");
      keepAwake();
      return video.play().catch(function () {});
    });
  }

  function setRun(on) {
    $("btnFaceStart").disabled = on && S.tab === "face";
    $("btnFaceStop").disabled = !(on && S.tab === "face");
    $("btnQrStart").disabled = on && S.tab === "qr";
    $("btnQrStop").disabled = !(on && S.tab === "qr");
  }

  function stopAll() {
    S.running = false;
    if (S.timer) { clearTimeout(S.timer); S.timer = null; }
    if (S.qr) {
      var q = S.qr;
      S.qr = null;
      try { q.stop().then(function () { q.clear(); }).catch(function () {}); } catch (e) { /* ข้าม */ }
    }
    if (S.stream) {
      S.stream.getTracks().forEach(function (t) { t.stop(); });
      S.stream = null;
    }
    ["camFace", "camEnroll"].forEach(function (id) {
      var v = $(id);
      v.srcObject = null;
      v.parentNode.classList.remove("live");
    });
    setRun(false);
  }

  /* ---------------- โมเดลใบหน้า ---------------- */
  function loadModels() {
    if (S.modelsReady) return Promise.resolve();
    if (!window.faceapi) {
      return Promise.reject(new Error("โหลดไลบรารีสแกนใบหน้าไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วรีเฟรชหน้า"));
    }
    return faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL)
      .then(function () { return faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL); })
      .then(function () { return faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL); })
      .then(function () { S.modelsReady = true; });
  }

  /* ---------------- สแกนใบหน้า ---------------- */
  function startFace() {
    stopAll();
    S.hold = {};
    say("faceMsg", "กำลังโหลดโมเดลใบหน้า (ครั้งแรกอาจใช้เวลาสักครู่)...", "warn");
    loadModels()
      .then(function () { return api("getFaceDB", { type: $("pType").value }); })
      .then(function (list) {
        S.db = list.map(function (p) { return { id: p.id, name: p.name, desc: new Float32Array(p.desc) }; });
        if (!S.db.length) {
          throw new Error("ยังไม่มีข้อมูลใบหน้าของกลุ่มนี้ — ไปที่แท็บ \"ลงทะเบียนใบหน้า\" ก่อน");
        }
        return openCamera($("camFace"));
      })
      .then(function () {
        S.running = true;
        setRun(true);
        say("faceMsg", "พร้อมสแกน — มีใบหน้าในฐานข้อมูล " + S.db.length + " คน", "ok");
        faceLoop();
      })
      .catch(function (e) {
        stopAll();
        say("faceMsg", errText(e), "err");
      });
  }

  function faceLoop() {
    if (!S.running) return;
    var v = $("camFace");
    var next = function () {
      if (S.running) S.timer = setTimeout(faceLoop, CFG.FACE_INTERVAL || 900);
    };
    if (S.busy || v.readyState < 2) { next(); return; }

    faceapi.detectSingleFace(v).withFaceLandmarks().withFaceDescriptor()
      .then(function (d) {
        if (!d || !S.running) return;
        var best = null, bd = 9;
        S.db.forEach(function (p) {
          var x = faceapi.euclideanDistance(d.descriptor, p.desc);
          if (x < bd) { bd = x; best = p; }
        });
        var th = parseFloat(S.info.threshold) || 0.45;
        if (best && bd <= th) {
          submit(best.id, "FACE");
        } else if (Date.now() - S.lastMissAt > 2500) {
          S.lastMissAt = Date.now();
          say("faceMsg", "ไม่พบใบหน้าที่ตรงกัน (ค่าความต่าง " + bd.toFixed(2) + ")", "warn");
        }
      })
      .catch(function () {})
      .then(next);
  }

  /* ---------------- สแกน QR ---------------- */
  function startQR() {
    stopAll();
    S.hold = {};
    if (!window.Html5Qrcode) {
      say("qrMsg", "โหลดไลบรารี QR ไม่สำเร็จ — ตรวจอินเทอร์เน็ตแล้วรีเฟรชหน้า", "err");
      return;
    }
    S.qr = new Html5Qrcode("reader");
    S.qr.start({ facingMode: $("camSel").value }, { fps: 10, qrbox: 240 },
      function (text) { submit(text, "QR"); }, function () {})
      .then(function () {
        keepAwake();
        setRun(true);
        say("qrMsg", "พร้อมสแกน QR", "ok");
      })
      .catch(function (e) {
        S.qr = null;
        say("qrMsg", errText(e), "err");
      });
  }

  $("manual").addEventListener("keydown", function (ev) {
    if (ev.key !== "Enter") return;
    submit(this.value, "TYPE");
    this.value = "";
  });

  /* ---------------- ส่งผลเช็คชื่อ ---------------- */
  function submit(code, method) {
    code = String(code || "").trim();
    if (!code || S.busy) return;
    var now = Date.now();
    if (S.hold[code] && now < S.hold[code]) return;
    S.hold[code] = now + 8000;
    S.busy = true;
    var mid = S.tab === "qr" ? "qrMsg" : "faceMsg";
    say(mid, "กำลังบันทึก...", "warn");

    api("checkIn", { code: code, type: $("pType").value, method: method })
      .then(function (r) {
        if (!r.ok) {
          say(mid, r.msg || "ไม่พบข้อมูล", "err");
          showResult(null, r.msg);
          beep(false);
          return;
        }
        if (r.already) S.hold[code] = Date.now() + 30000;
        say(mid, r.already ? "เช็คชื่อไปแล้ว" : "บันทึกสำเร็จ", r.already ? "warn" : "ok");
        showResult(r);
        addLog(r);
        beep(true);
      })
      .catch(function (e) {
        delete S.hold[code];
        say(mid, errText(e), "err");
        if (e.code === "BAD_PIN") { stopAll(); S.pin = ""; localStorage.removeItem("scan_pin"); askScanPin(e.message); }
      })
      .then(function () { S.busy = false; });
  }

  function showResult(r, errMsg) {
    var el = $("result");
    var photo = $("rPhoto");
    if (!r) {
      el.className = "result bad scanonly";
      $("rName").textContent = errMsg || "ไม่พบข้อมูล";
      $("rSub").textContent = "";
      $("rNote").textContent = "";
      $("rStatus").textContent = "ไม่สำเร็จ";
      $("rTime").textContent = "";
      photo.hidden = true;
      return;
    }
    el.className = "result " + statusClass(r.status) + (r.already ? " again" : "") + " scanonly";
    $("rName").textContent = r.name;
    $("rSub").textContent = [r.dept, r.level ? r.level + (r.group ? "/" + r.group : "") : ""].filter(Boolean).join("  ");
    $("rNote").textContent = r.already ? "เช็คชื่อไปแล้ว" : "";
    $("rStatus").textContent = r.status;
    $("rTime").textContent = (r.time || "").slice(0, 8);
    if (r.photo) { photo.src = r.photo; photo.hidden = false; } else { photo.hidden = true; }
  }

  function addLog(r) {
    var tb = $("log");
    var empty = tb.querySelector(".empty");
    if (empty) empty.remove();
    var tr = document.createElement("tr");
    [(r.time || "").slice(0, 8), r.name, r.dept].forEach(function (t, i) {
      var td = document.createElement("td");
      if (i === 1) td.className = "l";
      td.textContent = t || "";
      tr.appendChild(td);
    });
    var td = document.createElement("td");
    var tag = document.createElement("span");
    tag.className = "tag " + statusClass(r.status);
    tag.textContent = r.status + (r.already ? " (ซ้ำ)" : "");
    td.appendChild(tag);
    tr.appendChild(td);
    tb.insertBefore(tr, tb.firstChild);
    while (tb.children.length > 40) tb.removeChild(tb.lastChild);
  }

  /* ---------------- ลงทะเบียนใบหน้า ---------------- */
  function loadPeople() {
    return api("listPeople", { type: $("eType").value }, true).then(function (list) {
      S.people = list;
      renderPeople();
      say("eMsg", "พบ " + list.length + " รายการ — เลือกบุคคล เปิดกล้อง แล้วกด \"เก็บใบหน้า\" 3 ครั้ง (หันหน้าตรง ซ้าย ขวาเล็กน้อย)", "warn");
    });
  }

  function renderPeople() {
    var q = $("eSearch").value.trim().toLowerCase();
    var sel = $("ePerson");
    sel.innerHTML = "";
    S.people
      .filter(function (p) { return !q || (p.id + " " + p.name).toLowerCase().indexOf(q) >= 0; })
      .slice(0, 300)
      .forEach(function (p) {
        sel.appendChild(new Option(p.id + "  " + p.name + (p.hasFace ? "   ✓ มีใบหน้าแล้ว" : ""), p.id));
      });
    if (sel.options.length) sel.selectedIndex = 0;
    resetShots();
  }

  function resetShots() {
    S.shots = [];
    renderShots();
  }
  function renderShots() {
    var dots = $("shots").children;
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i < S.shots.length);
  }

  function enrollCam() {
    stopAll();
    say("eMsg", "กำลังโหลดโมเดลใบหน้า...", "warn");
    loadModels()
      .then(function () { return openCamera($("camEnroll")); })
      .then(function () { say("eMsg", "กล้องพร้อม — หันหน้าตรง แล้วกด \"เก็บใบหน้า\"", "ok"); })
      .catch(function (e) { stopAll(); say("eMsg", errText(e), "err"); });
  }

  function capture() {
    if (!S.stream) { say("eMsg", "กรุณาเปิดกล้องก่อน", "err"); return; }
    var id = $("ePerson").value;
    if (!id) { say("eMsg", "กรุณาเลือกบุคคลก่อน", "err"); return; }
    if (S.busy) return;
    var person = S.people.filter(function (p) { return p.id === id; })[0];
    if (S.shots.length === 0 && person && person.hasFace &&
        !confirm("คนนี้มีข้อมูลใบหน้าอยู่แล้ว ต้องการเก็บใหม่แทนที่หรือไม่?")) return;

    S.busy = true;
    faceapi.detectSingleFace($("camEnroll")).withFaceLandmarks().withFaceDescriptor()
      .then(function (d) {
        if (!d) { say("eMsg", "ไม่พบใบหน้า ลองใหม่อีกครั้ง", "err"); return; }
        if (d.detection.score < 0.7) { say("eMsg", "ใบหน้าไม่ชัด — เพิ่มแสงสว่างหรือขยับเข้าใกล้กล้อง", "err"); return; }
        S.shots.push(Array.from(d.descriptor));
        renderShots();
        if (S.shots.length < 3) {
          say("eMsg", "เก็บแล้ว " + S.shots.length + "/3 — เปลี่ยนมุมหน้าเล็กน้อย แล้วกดอีกครั้ง", "warn");
          return;
        }
        var shots = S.shots;
        var avg = shots[0].map(function (_, i) {
          var sum = 0;
          for (var k = 0; k < shots.length; k++) sum += shots[k][i];
          return Math.round(sum / shots.length * 1e6) / 1e6;
        });
        say("eMsg", "กำลังบันทึก...", "warn");
        return api("saveFace", { type: $("eType").value, id: id, desc: avg }, true).then(function (r) {
          say("eMsg", r.msg || "บันทึกแล้ว", r.ok ? "ok" : "err");
          resetShots();
          return loadPeople().then(function () {
            var keep = $("ePerson");
            for (var i = 0; i < keep.options.length; i++) if (keep.options[i].value === id) keep.selectedIndex = i;
          });
        });
      })
      .catch(function (e) { adminErr(e); })
      .then(function () { S.busy = false; });
  }

  /* ---------------- ผูกปุ่ม ---------------- */
  $("btnFaceStart").addEventListener("click", startFace);
  $("btnFaceStop").addEventListener("click", function () { stopAll(); say("faceMsg", "หยุดสแกนแล้ว", "warn"); });
  $("btnQrStart").addEventListener("click", startQR);
  $("btnQrStop").addEventListener("click", function () { stopAll(); say("qrMsg", "หยุดสแกนแล้ว", "warn"); });
  $("btnECam").addEventListener("click", enrollCam);
  $("btnECap").addEventListener("click", capture);
  $("btnEStop").addEventListener("click", function () { stopAll(); say("eMsg", "ปิดกล้องแล้ว", "warn"); });
  $("eType").addEventListener("change", function () { loadPeople().catch(adminErr); });
  $("eSearch").addEventListener("input", renderPeople);
  $("ePerson").addEventListener("change", resetShots);

  $("pType").addEventListener("change", function () {
    S.hold = {};
    if (S.tab === "face" && S.running) startFace();
  });
  $("camSel").addEventListener("change", function () {
    if (S.tab === "face" && S.running) startFace();
    else if (S.tab === "qr" && S.qr) startQR();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && S.stream) keepAwake();
  });

  /* ---------------- เริ่มทำงาน ---------------- */
  if (!CFG.GAS_URL || /XXXX/.test(CFG.GAS_URL)) {
    fatal("ยังไม่ได้ตั้งค่า GAS_URL ในไฟล์ config.js");
  } else if (!S.pin) {
    askScanPin();
  } else {
    connect();
  }
})();
