import { db, auth, ensureAnonAuth, Fire, GameStatus } from "./firebase.js";
const { doc, getDoc, setDoc, onSnapshot, increment, updateDoc } = Fire;

// Load confetti via CDN
const script = document.createElement('script');
script.src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.6.0/dist/confetti.browser.min.js";
document.head.appendChild(script);


// State
let currentGameId = null;
let currentPin = null;
let playerProfile = { name: "", score: 0 };
let currentQIndex = -1;
let hasAnswered = false;
let gameUnsubscribe = null;

// DOM
const screens = {
    join: document.getElementById("screen-join"),
    lobby: document.getElementById("screen-lobby"),
    question: document.getElementById("screen-question"),
    feedback: document.getElementById("screen-feedback"),
    end: document.getElementById("screen-end")
};

const joinBtn = document.getElementById("joinBtn");
const joinPin = document.getElementById("joinPin");
const joinName = document.getElementById("joinName");
const joinStatus = document.getElementById("joinStatus");

const welcomeName = document.getElementById("welcomeName");
const studentTimer = document.getElementById("studentTimer");
const feedbackMsg = document.getElementById("feedback-msg");
const feedbackIcon = document.getElementById("feedback-icon");
const pointsWon = document.getElementById("points-won");
const currentScoreEl = document.getElementById("currentScore");
const finalRank = document.getElementById("finalRank");
const finalScore = document.getElementById("finalScore");

function showScreen(screenId) {
    Object.values(screens).forEach(s => s.classList.remove("active"));
    screens[screenId].classList.add("active");
}

// 1. Join Logic
joinBtn.addEventListener("click", async () => {
    const pin = joinPin.value.trim();
    const name = joinName.value.trim();

    if (!/^\d{6}$/.test(pin)) return (joinStatus.textContent = "Enter 6-digit PIN");
    if (name.length < 2) return (joinStatus.textContent = "Name too short");

    joinStatus.textContent = "Joining game...";
    const user = await ensureAnonAuth();

    const pinSnap = await getDoc(doc(db, "pins", pin));
    if (!pinSnap.exists()) return (joinStatus.textContent = "PIN not found!");

    currentGameId = pinSnap.data().gameId;
    currentPin = pin;
    playerProfile.name = name;

    await setDoc(doc(db, "games", currentGameId, "players", user.uid), {
        name, score: 0, lastAnsweredIndex: -1
    }, { merge: true });

    welcomeName.textContent = `Welcome, ${name}!`;
    showScreen("lobby");
    startListening();
});

// 2. Real-time Listening
function startListening() {
    if (gameUnsubscribe) gameUnsubscribe();

    gameUnsubscribe = onSnapshot(doc(db, "games", currentGameId), async (snap) => {
        const game = snap.data();
        if (!game) return;

        switch (game.status) {
            case GameStatus.LOBBY:
                showScreen("lobby");
                break;

            case GameStatus.QUESTION:
                if (currentQIndex !== game.qIndex) {
                    currentQIndex = game.qIndex;
                    hasAnswered = false;
                    prepareQuestion(game);
                }
                break;

            case GameStatus.REVEAL:
                if (!hasAnswered) {
                    handleAnswer(null, false, 0); // Out of time
                }
                break;

            case GameStatus.FINISHED:
                showFinalResults();
                break;
        }
    });
}

// 3. Question Logic
async function prepareQuestion(game) {
    showScreen("question");
    studentTimer.style.width = "100%";

    // Dynamic timer animation
    const duration = game.questionDurationSec * 1000;
    studentTimer.style.transition = `width ${game.questionDurationSec}s linear`;
    setTimeout(() => studentTimer.style.width = "0%", 10);

    const quizSnap = await getDoc(doc(db, "quizzes", game.quizId));
    const quiz = quizSnap.data();
    const q = quiz.questions[game.qIndex];

    // Enable buttons
    document.querySelectorAll(".answer-btn").forEach((btn, i) => {
        btn.classList.remove("disabled", "selected");
        btn.onclick = () => {
            if (hasAnswered) return;
            const isCorrect = (i === q.correctIndex);
            const elapsed = Date.now() - game.questionStartMs;
            const points = isCorrect ? calculatePoints(elapsed, duration, game) : 0;
            submitAnswer(i, isCorrect, points);
            btn.classList.add("selected");
        };
    });
}

function calculatePoints(elapsed, total, game) {
    const remaining = Math.max(0, total - elapsed);
    const ratio = remaining / total;
    let base = 500;
    let bonus = 500;

    if (game.gameMode === "speed") {
        base = 1000;
        bonus = 1000;
    }

    return Math.floor(base + (bonus * ratio));
}

async function submitAnswer(index, isCorrect, points) {
    hasAnswered = true;
    document.querySelectorAll(".answer-btn").forEach(btn => btn.classList.add("disabled"));

    const uid = auth.currentUser.uid;
    const gameSnap = await getDoc(doc(db, "games", currentGameId));
    const game = gameSnap.data();

    // Survival Mode Penalty
    let finalPoints = points;
    if (!isCorrect && game.gameMode === "survival") {
        finalPoints = -200;
    }

    await setDoc(doc(db, "games", currentGameId, "answers", `${uid}_${currentQIndex}`), {
        uid, index, isCorrect, points: finalPoints, timestamp: Date.now()
    });

    if (finalPoints !== 0) {
        await updateDoc(doc(db, "games", currentGameId, "players", uid), {
            score: increment(finalPoints)
        });
    }

    handleAnswer(index, isCorrect, finalPoints);
}

function handleAnswer(index, isCorrect, points) {
    showScreen("feedback");
    feedbackMsg.textContent = isCorrect ? "CORRECT!" : (index === null ? "OUT OF TIME" : "WRONG!");
    feedbackIcon.textContent = isCorrect ? "✅" : "❌";
    pointsWon.textContent = points > 0 ? `+ ${points} pts` : "Try faster next time!";

    // Get latest score
    getDoc(doc(db, "games", currentGameId, "players", auth.currentUser.uid)).then(d => {
        currentScoreEl.textContent = d.data().score.toLocaleString();
    });

    if (isCorrect) {
        document.getElementById("sfxCorrect").play().catch(() => { });
        if (window.confetti) {
            window.confetti({
                particleCount: 150,
                spread: 70,
                origin: { y: 0.6 },
                colors: ['#6d5efc', '#22d3ee', '#10b981']
            });
        }
    }
    else document.getElementById("sfxWrong").play().catch(() => { });
}

async function showFinalResults() {
    const uid = auth.currentUser.uid;
    const pSnap = await getDoc(doc(db, "games", currentGameId, "players", uid));
    const score = pSnap.data().score;

    // Get rank (simplified: just list all and find index)
    const allPlayers = await Fire.getDocs(Fire.query(Fire.collection(db, "games", currentGameId, "players"), Fire.orderBy("score", "desc")));
    let rank = 1;
    let i = 1;
    allPlayers.forEach(d => {
        if (d.id === uid) rank = i;
        i++;
    });

    finalRank.textContent = `#${rank}`;

    let label = "Rookie";
    if (score >= 3000) label = "Master";
    else if (score >= 1000) label = "Pro";

    finalScore.innerHTML = `Total Points: ${score.toLocaleString()}<br><span style="color:var(--accent-secondary)">Rank: ${label}</span>`;
    showScreen("end");
}
