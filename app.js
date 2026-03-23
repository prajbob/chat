console.log("App starting...");

// -------------------- MOBILE VIEWPORT FIX --------------------
function setVh() {
  document.documentElement.style.setProperty("--vh", window.innerHeight * 0.01 + "px");
}
setVh();
window.addEventListener("resize", setVh);

// Firebase imports
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  addDoc,
  onSnapshot,
  query,
  orderBy,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  getDocs,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyAHKFIROYcYK_bHqsZGpK6GNJKyBOL3gWY",
  authDomain: "chat-230c0.firebaseapp.com",
  projectId: "chat-230c0",
  storageBucket: "chat-230c0.firebasestorage.app",
  messagingSenderId: "613178411959",
  appId: "1:613178411959:web:a591ec9eb9a0017da4f632"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// -------------------- STATE --------------------
let currentUserData = null;
let currentConvId = null;
let currentUnsubscribeMessages = null;
let cachedUsersSnapshot = null;
const uidToUsername = {};
let replyingTo = null;
// Load lastRead from localStorage on startup
const lastRead = JSON.parse(localStorage.getItem("lastRead") || "{}");
const unreadFlags = {}; // convId -> bool
const convUnsubscribers = {}; // convId -> unsubscribe fn

// YOUR uid — swap this to your actual uid from Firebase Auth
// Friends will see only their conversation with you
const OWNER_UID = "FswYy0OApWPE1VAHKJnJ6xwexwU2";

const CLOUDINARY_CLOUD = "dntdjc6jr";
const CLOUDINARY_PRESET = "chat_prajbob";

// -------------------- HELPERS --------------------
function getConvId(uid1, uid2) {
  return [uid1, uid2].sort().join("_");
}

function isOwner() {
  return auth.currentUser?.uid === OWNER_UID;
}

// -------------------- LOGIN FORM --------------------
document.getElementById("loginForm").addEventListener("submit", (e) => {
  e.preventDefault();
  login();
});

// -------------------- AUTH STATE --------------------
onAuthStateChanged(auth, async (user) => {
  const loginSection = document.getElementById("loginSection");
  const chatSection = document.getElementById("chatSection");

  if (user) {
    loginSection.style.display = "none";
    chatSection.style.display = "flex";

    // Load or create user doc
    const userDocRef = doc(db, "users", user.uid);
    const userSnap = await getDoc(userDocRef);

    if (userSnap.exists()) {
      currentUserData = userSnap.data();
    } else {
      const username = prompt("Enter a username:");
      await setDoc(userDocRef, {
        email: user.email,
        username,
        joinTime: Date.now(),
        lastActive: Date.now(),
        typing: false
      });
      currentUserData = { email: user.email, username, joinTime: Date.now() };
    }

    uidToUsername[user.uid] = currentUserData.username;
    setInterval(() => updateOnlineStatus(), 10000);
    showWhatsNewIfNeeded();
    setupChatObserver();
    trackTyping();

    if (isOwner()) {
      // Owner: load friend list, wait for selection
      loadFriendList();
    } else {
      // Friend: jump straight into convo with owner
      document.querySelector(".sidebar-wrap").style.display = "none";
      // Pre-fetch owner username so header shows instantly
      if (!uidToUsername[OWNER_UID]) {
        const ownerSnap = await getDoc(doc(db, "users", OWNER_UID));
        uidToUsername[OWNER_UID] = ownerSnap.exists() ? ownerSnap.data().username : "Unknown";
      }
      const convId = getConvId(user.uid, OWNER_UID);
      openConversation(convId, OWNER_UID);
    }

  } else {
    loginSection.style.display = "block";
    chatSection.style.display = "none";
    currentUserData = null;
    currentConvId = null;
  }
});

// -------------------- SETTINGS MENU --------------------
window.toggleSettings = function(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById("settingsMenu");
  if (!menu) return;
  const isOpen = menu.style.display === "block";
  menu.style.display = isOpen ? "none" : "block";
  if (!isOpen) {
    setTimeout(() => document.addEventListener("click", (ev) => {
      if (!menu.contains(ev.target)) menu.style.display = "none";
    }, { once: true }), 0);
  }
};

// -------------------- IMAGE LIGHTBOX --------------------
window.openLightbox = function(src) {
  const overlay = document.createElement("div");
  overlay.className = "lightbox-overlay";
  overlay.innerHTML = `<img class="lightbox-img" src="${src}"/>`;
  overlay.onclick = () => overlay.remove();
  document.body.appendChild(overlay);
};

// -------------------- WHATS NEW --------------------
const CHAT_VERSION = "2.0";

function showWhatsNewIfNeeded() {
  if (localStorage.getItem("chatVersion") !== CHAT_VERSION) {
    document.getElementById("whatsNewModal").style.display = "flex";
  }
}

window.dismissWhatsNew = function() {
  localStorage.setItem("chatVersion", CHAT_VERSION);
  document.getElementById("whatsNewModal").style.display = "none";
};

// -------------------- LOGIN --------------------
window.login = async function () {
  const email = document.getElementById("email").value;
  const password = document.getElementById("password").value;
  try {
    await signInWithEmailAndPassword(auth, email, password);
  } catch (err) {
    alert(err.message);
  }
};

// -------------------- LOGOUT --------------------
window.logout = async function () {
  await updateOnlineStatus(false);
  await signOut(auth);
  location.reload();
};

// -------------------- CHANGE USERNAME --------------------
window.changeUsername = async function () {
  if (!currentUserData) return;
  const newName = prompt("Enter your new username:", currentUserData.username);
  if (!newName) return;
  const userDocRef = doc(db, "users", auth.currentUser.uid);
  await updateDoc(userDocRef, { username: newName });
  currentUserData.username = newName;
  uidToUsername[auth.currentUser.uid] = newName;
  alert("Username updated!");
};

// -------------------- ONLINE STATUS --------------------
async function updateOnlineStatus(active = true) {
  if (!auth.currentUser) return;
  await updateDoc(doc(db, "users", auth.currentUser.uid), {
    lastActive: active ? Date.now() : null
  });
}

// -------------------- FRIEND LIST (owner only) --------------------
async function loadFriendList() {
  const sidebar = document.getElementById("onlineUsers");

  // Fetch all users except owner
  const snapshot = await getDocs(collection(db, "users"));
  cachedUsersSnapshot = snapshot;

  renderFriendList(snapshot);

  // Re-render online status every 15s
  setInterval(() => renderFriendList(cachedUsersSnapshot), 15000);

  // Live updates
  onSnapshot(collection(db, "users"), (snap) => {
    cachedUsersSnapshot = snap;
    renderFriendList(snap);
  });

  // Watch each friend convo for unread messages
  snapshot.forEach(d => {
    if (d.id === OWNER_UID) return;
    const convId = getConvId(OWNER_UID, d.id);
    watchConvForUnread(convId);
  });
}

// -------------------- WATCH CONV FOR UNREAD --------------------
function watchConvForUnread(convId) {
  if (convUnsubscribers[convId]) return; // already watching
  const q = query(
    collection(db, "conversations", convId, "messages"),
    orderBy("timestamp")
  );
  const unsub = onSnapshot(q, (snapshot) => {
    if (convId === currentConvId) return; // currently open, ignore
    snapshot.docChanges().forEach(change => {
      if (change.type === "added") {
        const data = change.doc.data();
        // Only flag if message is from the other person
        if (data.uid !== OWNER_UID) {
          const ts = data.timestamp || 0;
          if (!lastRead[convId] || ts > lastRead[convId]) {
            unreadFlags[convId] = true;
            if (cachedUsersSnapshot) renderFriendList(cachedUsersSnapshot);
          }
        }
      }
    });
  });
  convUnsubscribers[convId] = unsub;
}

function renderFriendList(snapshot) {
  const sidebar = document.getElementById("onlineUsers");
  sidebar.innerHTML = "<strong>Chats</strong>";

  snapshot.forEach(d => {
    if (d.id === OWNER_UID) return; // skip yourself
    const data = d.data();
    const username = data.username || "Unknown";
    const isOnline = data.lastActive && (Date.now() - data.lastActive) < 30000;
    const convId = getConvId(OWNER_UID, d.id);
    const isActive = convId === currentConvId;

    const div = document.createElement("div");
    div.className = "friend-item" + (isActive ? " active" : "");
    const hasUnread = unreadFlags[convId] && !isActive;
    div.innerHTML = `
      <span class="friend-name">${username}</span>
      <span class="friend-badge-wrap">
        ${hasUnread ? '<span class="unread-badge"></span>' : ''}
        <span class="friend-status ${isOnline ? "online" : ""}"></span>
      </span>
    `;
    div.onclick = () => {
      // Always set from cached snapshot data so header shows instantly
      uidToUsername[d.id] = data.username || "Unknown";
      openConversation(convId, d.id);
    };
    sidebar.appendChild(div);
  });
}

// -------------------- OPEN CONVERSATION --------------------
function openConversation(convId, otherUid) {
  currentConvId = convId;

  // Unsubscribe from previous convo
  if (currentUnsubscribeMessages) {
    currentUnsubscribeMessages();
    currentUnsubscribeMessages = null;
  }

  // Update active state in sidebar
  if (isOwner()) renderFriendList(cachedUsersSnapshot);

  // Update header
  const name = uidToUsername[otherUid] || "...";
  document.getElementById("chatHeader").textContent = name;

  // Mark as read
  lastRead[convId] = Date.now();
  localStorage.setItem("lastRead", JSON.stringify(lastRead));
  unreadFlags[convId] = false;
  if (isOwner()) renderFriendList(cachedUsersSnapshot);

  // Load messages for this convo
  loadMessages(convId);
}

// -------------------- TYPING INDICATOR --------------------
function trackTyping() {
  const input = document.getElementById("message");
  input.addEventListener("input", async () => {
    if (!auth.currentUser || !currentConvId) return;
    await updateDoc(doc(db, "users", auth.currentUser.uid), {
      typing: input.value.length > 0 ? currentConvId : false
    });
  });

  onSnapshot(collection(db, "users"), (snapshot) => {
    const typers = [];
    snapshot.forEach(d => {
      const data = d.data();
      // Show typing if they're typing in the current conversation
      if (data.typing === currentConvId && d.id !== auth.currentUser?.uid) {
        typers.push(data.username || "Someone");
      }
    });
    document.getElementById("typingIndicator").textContent =
      typers.length ? `${typers.join(", ")} is typing...` : "";
  });
}

// -------------------- DATE SEPARATOR --------------------
let lastRenderedDate = null;

function getDateLabel(timestamp) {
  const d = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function maybeInsertDateSeparator(timestamp, chat) {
  const label = getDateLabel(timestamp);
  if (label !== lastRenderedDate) {
    lastRenderedDate = label;
    const sep = document.createElement("div");
    sep.className = "date-sep";
    sep.textContent = label;
    chat.appendChild(sep);
  }
}

// -------------------- LINKIFY --------------------
function linkify(text) {
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  return text.replace(urlRegex, (url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
  });
}

// -------------------- UPLOAD IMAGE --------------------
window.sendImage = async function() {
  const input = document.getElementById("imageInput");
  const file = input.files[0];
  if (!file || !currentConvId || !auth.currentUser) return;

  const btn = document.getElementById("imageBtn");
  btn.style.opacity = "0.4";
  btn.style.pointerEvents = "none";

  try {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("upload_preset", CLOUDINARY_PRESET);

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
      { method: "POST", body: formData }
    );
    const data = await res.json();
    const imageUrl = data.secure_url;

    // Send as a message with type image
    const messagesRef = collection(db, "conversations", currentConvId, "messages");
    await addDoc(messagesRef, {
      type: "image",
      imageUrl,
      uid: auth.currentUser.uid,
      timestamp: Date.now(),
      readBy: [auth.currentUser.uid]
    });

    input.value = "";
  } catch (err) {
    console.error("Image upload error:", err);
    alert("Upload failed, try again");
  } finally {
    btn.style.opacity = "1";
    btn.style.pointerEvents = "auto";
  }
};

// -------------------- REPLY --------------------
window.setReply = function(msgId, text, username) {
  replyingTo = { msgId, text, username };
  const preview = document.getElementById("replyPreview");
  const previewText = document.getElementById("replyPreviewText");
  previewText.textContent = username + ": " + (text ? (text.length > 60 ? text.slice(0, 60) + "..." : text) : "📷 Photo");
  preview.style.display = "flex";
  document.getElementById("message").focus();
};

window.cancelReply = function() {
  replyingTo = null;
  document.getElementById("replyPreview").style.display = "none";
};

// -------------------- SEND MESSAGE --------------------
window.sendMessage = async function () {
  const msg = document.getElementById("message").value.trim();
  if (!msg || !currentUserData || !auth.currentUser || !currentConvId) return;
  try {
    const messagesRef = collection(db, "conversations", currentConvId, "messages");
    const msgData = {
      text: msg,
      uid: auth.currentUser.uid,
      timestamp: Date.now(),
      readBy: [auth.currentUser.uid]
    };
    if (replyingTo) msgData.replyTo = replyingTo;
    await addDoc(messagesRef, msgData);
    document.getElementById("message").value = "";
    cancelReply();
    await updateDoc(doc(db, "users", auth.currentUser.uid), { typing: false });
  } catch (err) {
    console.error("Send error:", err);
  }
};

// -------------------- LOAD MESSAGES --------------------
function loadMessages(convId) {
  const chat = document.getElementById("chat");
  chat.innerHTML = "";
  lastRenderedDate = null;

  const q = query(
    collection(db, "conversations", convId, "messages"),
    orderBy("timestamp")
  );

  const unsubscribe = onSnapshot(q, async (snapshot) => {
    // Fetch any unknown usernames
    const uidsToFetch = new Set();
    snapshot.forEach(d => {
      const data = d.data();
      if (data.uid && !uidToUsername[data.uid]) uidsToFetch.add(data.uid);
    });
    await Promise.all([...uidsToFetch].map(async uid => {
      const userSnap = await getDoc(doc(db, "users", uid));
      uidToUsername[uid] = userSnap.exists() ? userSnap.data().username : "Unknown";
    }));

    for (const change of snapshot.docChanges()) {
      const data = change.doc.data();
      const msgId = change.doc.id;

      if (change.type === "added") {
        const username = uidToUsername[data.uid] || "Unknown";
        const time = new Date(data.timestamp).toLocaleTimeString();
        const isMe = data.uid === auth.currentUser.uid;

        // Mark as read
        const readBy = data.readBy || [];
        if (!readBy.includes(auth.currentUser.uid)) {
          await updateDoc(
            doc(db, "conversations", convId, "messages", msgId),
            { readBy: [...readBy, auth.currentUser.uid] }
          );
        }

        const isRead = readBy.filter(uid => uid !== data.uid).length > 0;
        const receiptSymbol = isRead ? "✔✔" : "✔";
        const receiptClass = isRead ? "msg-receipt read" : "msg-receipt";

        maybeInsertDateSeparator(data.timestamp, chat);

        const isImage = data.type === "image";
        const div = document.createElement("div");
        div.className = "msg " + (isMe ? "me" : "") + (isImage ? " msg-has-image" : "");
        div.dataset.id = msgId;
        const contentHtml = isImage
          ? `<img class="msg-img" src="${data.imageUrl}" alt="image" onclick="openLightbox(this.src)"/>`
          : `<span class="msg-text">${linkify(data.text)}</span>`;

        const editedTag = data.edited ? '<span class="msg-edited">edited</span>' : "";
        const replyQuoteText = data.replyTo ? (data.replyTo.text ? (data.replyTo.text.length > 50 ? data.replyTo.text.slice(0,50)+"..." : data.replyTo.text) : "📷 Photo") : "";
        const replyHtml = data.replyTo ? `<div class="reply-quote" onclick="scrollToMsg('${data.replyTo.msgId}')"><span class="reply-quote-name">${data.replyTo.username}</span><span class="reply-quote-text">${replyQuoteText}</span></div>` : "";
        div.innerHTML = `
          <small class="msg-username">${username}</small>
          ${replyHtml}
          ${contentHtml}
          <span class="msg-meta">
            ${editedTag}
            <small class="msg-time">${time}</small>
            ${isMe ? `<span class="${receiptClass}">${receiptSymbol}</span>` : ""}
          </span>`;

        // Attach menu triggers — always, for every message
        const textContent = data.text || "";
        const senderName = uidToUsername[data.uid] || "Unknown";
        const withinTimeLimit = (Date.now() - data.timestamp) < 30 * 60 * 1000;

        // Desktop: three dot button (always visible on hover)
        const dotsBtn = document.createElement("button");
        dotsBtn.className = "msg-dots";
        dotsBtn.textContent = "•••";
        dotsBtn.onclick = (e) => {
          e.stopPropagation();
          showMsgMenu(e, msgId, convId, isMe, isOwner(), textContent, isImage, withinTimeLimit, senderName);
        };
        div.appendChild(dotsBtn);

        // Mobile: long press + swipe
        let pressTimer;
        let touchStartX = 0;
        let swiped = false;
        div.addEventListener("touchstart", (e) => {
          touchStartX = e.touches[0].clientX;
          swiped = false;
          pressTimer = setTimeout(() => {
            showMsgMenu({ preventDefault: ()=>{}, stopPropagation: ()=>{}, currentTarget: div }, msgId, convId, isMe, isOwner(), textContent, isImage, withinTimeLimit, senderName);
          }, 400);
        });
        div.addEventListener("touchmove", (e) => {
          const dx = e.touches[0].clientX - touchStartX;
          if (dx > 50 && !swiped) {
            swiped = true;
            clearTimeout(pressTimer);
            setReply(msgId, textContent, senderName);
            div.style.transition = "transform 0.15s";
            div.style.transform = "translateX(24px)";
            setTimeout(() => { div.style.transform = ""; }, 200);
          }
        });
        div.addEventListener("touchend", () => clearTimeout(pressTimer));

        chat.appendChild(div);

      } else if (change.type === "modified") {
        const existing = chat.querySelector(`[data-id="${msgId}"]`);
        if (existing) {
          // Update receipt
          if (data.uid === auth.currentUser.uid) {
            const receiptEl = existing.querySelector(".msg-receipt");
            if (receiptEl) {
              const readBy = data.readBy || [];
              const isRead = readBy.filter(uid => uid !== data.uid).length > 0;
              receiptEl.textContent = isRead ? "✔✔" : "✔";
              receiptEl.className = isRead ? "msg-receipt read" : "msg-receipt";
            }
          }
          // Update edited text
          if (data.edited) {
            const textEl = existing.querySelector(".msg-text");
            if (textEl) textEl.innerHTML = linkify(data.text);
            if (!existing.querySelector(".msg-edited")) {
              const meta = existing.querySelector(".msg-meta");
              if (meta) meta.insertAdjacentHTML("afterbegin", '<span class="msg-edited">edited</span>');
            }
          }
        }
      } else if (change.type === "removed") {
        const existing = chat.querySelector(`[data-id="${msgId}"]`);
        if (existing) existing.remove();
      }
    }

    requestAnimationFrame(() => {
      chat.scrollTop = chat.scrollHeight;
    });
  });

  currentUnsubscribeMessages = unsubscribe;
}

// -------------------- DELETE MESSAGE --------------------
window.deleteMessage = async function(msgId, convId) {
  if (!confirm("Delete this message?")) return;
  try {
    await deleteDoc(doc(db, "conversations", convId, "messages", msgId));
  } catch (err) {
    console.error("Delete error:", err);
  }
};

// -------------------- EDIT MESSAGE --------------------
let editTarget = null;

window.editMessage = function(msgId, convId, currentText) {
  editTarget = { msgId, convId };
  const modal = document.getElementById("editModal");
  const input = document.getElementById("editInput");
  input.value = currentText;
  modal.style.display = "flex";
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
};

window.cancelEdit = function() {
  editTarget = null;
  document.getElementById("editModal").style.display = "none";
};

window.confirmEdit = async function() {
  if (!editTarget) return;
  const newText = document.getElementById("editInput").value.trim();
  if (!newText) return;
  try {
    await updateDoc(doc(db, "conversations", editTarget.convId, "messages", editTarget.msgId), {
      text: newText,
      edited: true
    });
    cancelEdit();
  } catch (err) {
    console.error("Edit error:", err);
  }
};

// -------------------- SHOW MSG MENU --------------------
function showMsgMenu(e, msgId, convId, isMe, isOwner, text, isImage, withinTimeLimit = false, senderName = "") {
  e.preventDefault();
  e.stopPropagation();

  // Remove any existing menu
  document.querySelectorAll(".msg-menu").forEach(m => m.remove());

  const canEdit = isMe && !isImage && withinTimeLimit;
  const canDelete = (isMe || isOwner) && withinTimeLimit;

  const menu = document.createElement("div");
  menu.className = "msg-menu";
  const escapedText = text.replace(/'/g, "\'").replace(/"/g, "&quot;");
  const escapedUsername = (senderName || "").replace(/'/g, "'");
  menu.innerHTML = `
    <div class="msg-menu-item" onclick="setReply('${msgId}', '${escapedText}', '${escapedUsername}'); this.parentElement.remove()">Reply</div>
    ${canEdit ? `<div class="msg-menu-item" onclick="editMessage('${msgId}', '${convId}', '${escapedText}'); this.parentElement.remove()">Edit</div>` : ""}
    ${canDelete ? `<div class="msg-menu-item delete" onclick="deleteMessage('${msgId}', '${convId}'); this.parentElement.remove()">Delete</div>` : ""}
  `;

  document.body.appendChild(menu);

  // Position near the message, keep in bounds
  const rect = e.currentTarget.getBoundingClientRect();
  const menuW = 120;
  const menuH = 80;
  let top = rect.bottom + 4;
  let left = rect.left;

  // Keep within viewport
  if (left + menuW > window.innerWidth) left = window.innerWidth - menuW - 8;
  if (top + menuH > window.innerHeight) top = rect.top - menuH - 4;
  if (left < 8) left = 8;

  menu.style.top = top + "px";
  menu.style.left = left + "px";

  // Close on outside click
  setTimeout(() => {
    document.addEventListener("click", () => menu.remove(), { once: true });
  }, 0);
}

// -------------------- SCROLL TO MESSAGE --------------------
window.scrollToMsg = function(msgId) {
  const el = document.querySelector(`[data-id="${msgId}"]`);
  if (el) {
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.style.transition = "background 0.3s";
    el.style.background = "rgba(255,255,255,0.1)";
    setTimeout(() => { el.style.background = ""; }, 1000);
  }
};

// -------------------- SCROLL WITH MUTATION OBSERVER --------------------
function setupChatObserver() {
  const chat = document.getElementById("chat");
  const observer = new MutationObserver(() => {
    requestAnimationFrame(() => {
      const threshold = 100;
      const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < threshold;
      if (atBottom) chat.scrollTop = chat.scrollHeight;
    });
  });
  observer.observe(chat, { childList: true, subtree: true });
}

// -------------------- EDIT MODAL KEYBOARD --------------------
document.addEventListener("keydown", (e) => {
  if (document.getElementById("editModal")?.style.display === "flex") {
    if (e.key === "Escape") cancelEdit();
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); confirmEdit(); }
  }
});

// -------------------- ENTER KEY SEND --------------------
document.getElementById("message").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});