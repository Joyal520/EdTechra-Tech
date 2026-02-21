import { db, auth, ensureAnonAuth, TS, Fire, GameStatus } from "./firebase.js";
const { doc, setDoc, getDocs, collection, query, orderBy, onSnapshot, updateDoc } = Fire;

// State
let currentGameId = null;
let currentQuiz = null;
let players = {};
let timerInterval = null;

// Audio
const sounds = {
    lobby: new Audio("https://assets.mixkit.co/active_storage/sfx/123/123-preview.mp3"),
    correct: new Audio("https://assets.mixkit.co/active_storage/sfx/2019/2019-preview.mp3"),
    tick: new Audio("https://assets.mixkit.co/active_storage/sfx/2571/2571-preview.mp3"),
    podium: new Audio("https://assets.mixkit.co/active_storage/sfx/2013/2013-preview.mp3")
};
sounds.lobby.loop = true;


// DOM Elements
const views = {
    setup: document.getElementById("view-setup"),
    lobby: document.getElementById("view-lobby"),
    question: document.getElementById("view-question"),
    podium: document.getElementById("view-podium")
};

const quizSelect = document.getElementById("quizSelect");
const modeSelect = document.getElementById("modeSelect"); // New
const createBtn = document.getElementById("createBtn");
const lobbyPin = document.getElementById("lobbyPin");

const playerCountEl = document.getElementById("playerCount");
const playerListEl = document.getElementById("playerList");
const startBtn = document.getElementById("startBtn");

const qTitle = document.getElementById("qTitle");
const qCounter = document.getElementById("qCounter");
const timerEl = document.getElementById("timer");
const optionsList = document.getElementById("optionsList");
const nextBtn = document.getElementById("nextBtn");
const answerStats = document.getElementById("answerStats");

// Initialization
async function init() {
    await ensureAnonAuth();
    loadQuizzes();

    // Handle URL parameters for mode
    const params = new URLSearchParams(window.location.search);
    const mode = params.get("mode");
    if (mode && modeSelect) {
        modeSelect.value = mode;
    }
}


async function loadQuizzes() {
    const snap = await getDocs(collection(db, "quizzes"));
    quizSelect.innerHTML = '<option value="">-- Choose Quiz --</option>';
    snap.forEach(d => {
        const q = d.data();
        const opt = document.createElement("option");
        opt.value = d.id;
        opt.textContent = q.title;
        quizSelect.appendChild(opt);
    });
}

function showView(viewId) {
    Object.values(views).forEach(v => v.style.display = "none");
    views[viewId].style.display = (viewId === 'setup') ? 'flex' : (viewId === 'question' ? 'flex' : 'grid');
    if (viewId === 'podium') views.podium.style.display = 'flex';
}

// 1. Setup Phase
createBtn.addEventListener("click", async () => {
    const quizId = quizSelect.value;
    const gameMode = modeSelect.value;
    if (!quizId) return alert("Select a quiz first!");

    const quizSnap = await Fire.getDoc(doc(db, "quizzes", quizId));
    currentQuiz = quizSnap.data();
    currentQuiz.id = quizId;

    const pin = String(Math.floor(100000 + Math.random() * 900000));
    currentGameId = crypto.randomUUID();

    await setDoc(doc(db, "games", currentGameId), {
        pin,
        status: GameStatus.LOBBY,
        quizId,
        gameMode,
        qIndex: -1,
        hostUid: auth.currentUser.uid,
        createdAt: TS()
    });

    await setDoc(doc(db, "pins", pin), { gameId: currentGameId });

    lobbyPin.textContent = pin;
    showView("lobby");
});

// 2. Lobby Phase
function listenToPlayers() {
    onSnapshot(collection(db, "games", currentGameId, "players"), (snap) => {
        players = {};
        playerListEl.innerHTML = "";
        snap.forEach(d => {
            const p = d.data();
            players[d.id] = p;
            const pill = document.createElement("div");
            pill.className = "player-pill";
            pill.textContent = p.name;
            playerListEl.appendChild(pill);
        });
        playerCountEl.textContent = `${snap.size} Players Joined`;
    });
}

startBtn.addEventListener("click", async () => {
    if (Object.keys(players).length === 0) return alert("Wait for players!");
    goToNextQuestion();
});

// 3. Question Phase
async function goToNextQuestion() {
    const nextIndex = (currentQuiz.currentQIndex ?? -1) + 1;
    currentQuiz.currentQIndex = nextIndex;

    if (nextIndex >= currentQuiz.questions.length) {
        return showPodium();
    }

    showView("question");
    const q = currentQuiz.questions[nextIndex];
    qTitle.textContent = q.question;
    qCounter.textContent = `Question ${nextIndex + 1} of ${currentQuiz.questions.length}`;

    // Mode-based settings
    let duration = 20;
    if (currentQuiz.gameMode === "speed") duration = 10;
    if (currentQuiz.gameMode === "survival") duration = 30;

    // Update Firestore
    const gameRef = doc(db, "games", currentGameId);
    const gameSnap = await Fire.getDoc(gameRef);
    const gameData = gameSnap.data();

    await updateDoc(gameRef, {
        status: GameStatus.QUESTION,
        qIndex: nextIndex,
        questionStartMs: Date.now(),
        questionDurationSec: duration
    });

    renderOptions(q.options);
    startTimer(duration);
    listenToAnswers(nextIndex);
}

function renderOptions(options) {
    optionsList.innerHTML = "";
    const colors = ['var(--kahoot-red)', 'var(--kahoot-blue)', 'var(--kahoot-green)', 'var(--kahoot-yellow)'];
    options.forEach((opt, i) => {
        const div = document.createElement("div");
        div.className = "glass-card flex-center";
        div.style.padding = "20px";
        div.style.background = colors[i % 4];
        div.style.fontSize = "1.5rem";
        div.style.fontWeight = "800";
        div.textContent = opt;
        optionsList.appendChild(div);
    });
}

function startTimer(sec) {
    let left = sec;
    timerEl.textContent = left;
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
        left--;
        timerEl.textContent = left;
        if (left <= 0) {
            clearInterval(timerInterval);
            revealAnswer();
        }
    }, 1000);
}

function listenToAnswers(qIndex) {
    const answersRef = collection(db, "games", currentGameId, "answers");
    // In a real app, you'd filter by qIndex, but we'll just check size for simplicity here
    onSnapshot(answersRef, (snap) => {
        const count = snap.docs.filter(d => d.id.endsWith(`_${qIndex}`)).length;
        answerStats.textContent = `${count} / ${Object.keys(players).length}`;
    });
}

async function revealAnswer() {
    await updateDoc(doc(db, "games", currentGameId), {
        status: GameStatus.REVEAL
    });

    // Highlight correct answer in host UI
    const q = currentQuiz.questions[currentQuiz.currentQIndex];
    const items = optionsList.children;
    for (let i = 0; i < items.length; i++) {
        if (i !== q.correctIndex) items[i].style.opacity = "0.3";
        else items[i].style.transform = "scale(1.1)";
    }
}

nextBtn.addEventListener("click", () => {
    if (timerInterval) clearInterval(timerInterval);
    goToNextQuestion();
});

// 4. Podium Phase
async function showPodium() {
    await updateDoc(doc(db, "games", currentGameId), {
        status: GameStatus.FINISHED
    });

    const pSnap = await getDocs(query(collection(db, "games", currentGameId, "players"), orderBy("score", "desc")));
    const leaderboard = [];
    pSnap.forEach(d => leaderboard.push(d.data()));

    showView("podium");
    if (leaderboard[0]) document.querySelector("#podium-1 .name").textContent = leaderboard[0].name;
    if (leaderboard[1]) document.querySelector("#podium-2 .name").textContent = leaderboard[1].name;
    if (leaderboard[2]) document.querySelector("#podium-3 .name").textContent = leaderboard[2].name;
}

init();
