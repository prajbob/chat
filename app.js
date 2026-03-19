console.log("App starting...");

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
  getDocs
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

// YOUR uid — swap this to your actual uid from Firebase Auth
// Friends will see only their conversation with you
const OWNER_UID = "FswYy0OApWPE1VAHKJnJ6xwexwU2";

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
    setupChatObserver();
    trackTyping();

    if (isOwner()) {
      // Owner: load friend list, wait for selection
      loadFriendList();
    } else {
      // Friend: jump straight into convo with owner
      document.getElementById("onlineUsers").style.display = "none";
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
    div.innerHTML = `
      <span class="friend-name">${username}</span>
      <span class="friend-status ${isOnline ? "online" : ""}"></span>
    `;
    div.onclick = () => openConversation(convId, d.id);
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

// -------------------- SEND MESSAGE --------------------
window.sendMessage = async function () {
  const msg = document.getElementById("message").value.trim();
  if (!msg || !currentUserData || !auth.currentUser || !currentConvId) return;
  try {
    const messagesRef = collection(db, "conversations", currentConvId, "messages");
    await addDoc(messagesRef, {
      text: msg,
      uid: auth.currentUser.uid,
      timestamp: Date.now(),
      readBy: [auth.currentUser.uid]
    });
    document.getElementById("message").value = "";
    await updateDoc(doc(db, "users", auth.currentUser.uid), { typing: false });
  } catch (err) {
    console.error("Send error:", err);
  }
};

// -------------------- LOAD MESSAGES --------------------
function loadMessages(convId) {
  const chat = document.getElementById("chat");
  chat.innerHTML = "";

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

        const div = document.createElement("div");
        div.className = "msg " + (isMe ? "me" : "");
        div.dataset.id = msgId;
        div.innerHTML = `
          <small class="msg-username">${username}</small>
          <span class="msg-text">${data.text}</span>
          <span class="msg-meta">
            <small class="msg-time">${time}</small>
            ${isMe ? `<span class="${receiptClass}">${receiptSymbol}</span>` : ""}
          </span>`;
        chat.appendChild(div);

      } else if (change.type === "modified") {
        const existing = chat.querySelector(`[data-id="${msgId}"]`);
        if (existing && data.uid === auth.currentUser.uid) {
          const receiptEl = existing.querySelector(".msg-receipt");
          if (receiptEl) {
            const readBy = data.readBy || [];
            const isRead = readBy.filter(uid => uid !== data.uid).length > 0;
            receiptEl.textContent = isRead ? "✔✔" : "✔";
            receiptEl.className = isRead ? "msg-receipt read" : "msg-receipt";
          }
        }
      }
    }

    requestAnimationFrame(() => {
      chat.scrollTop = chat.scrollHeight;
    });
  });

  currentUnsubscribeMessages = unsubscribe;
}

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

// -------------------- ENTER KEY SEND --------------------
document.getElementById("message").addEventListener("keydown", function (e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});