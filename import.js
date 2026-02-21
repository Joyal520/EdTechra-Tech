import { db, TS, Fire } from "./firebase.js";
const { collection, addDoc } = Fire;

const quizInput = document.getElementById("quizInput");
const importBtn = document.getElementById("importBtn");
const statusDiv = document.getElementById("status");

function setStatus(msg, type = "info") {
    statusDiv.textContent = msg;
    statusDiv.style.color = type === "error" ? "var(--accent-error)" : (type === "success" ? "var(--accent-success)" : "var(--text-bright)");
}

importBtn.addEventListener("click", async () => {
    const text = quizInput.value.trim();
    if (!text) return setStatus("Please paste some quiz data first!", "error");

    try {
        setStatus("Parsing quiz data...", "info");
        const quizData = parseEQM(text);

        if (!quizData.questions || quizData.questions.length === 0) {
            throw new Error("No questions found. Check your format!");
        }

        setStatus(`Saving "${quizData.title}" to Firestore...`, "info");

        await addDoc(collection(db, "quizzes"), {
            ...quizData,
            createdAt: TS()
        });

        setStatus(`✅ Success! Quiz "${quizData.title}" is ready for battle.`, "success");
        quizInput.value = "";
    } catch (err) {
        console.error(err);
        setStatus(`Error: ${err.message}`, "error");
    }
});

function parseEQM(text) {
    const lines = text.split("\n").map(l => l.trim());
    let title = "Untitled Quiz";
    const questions = [];
    let currentQ = null;

    lines.forEach(line => {
        if (line.toUpperCase().startsWith("TITLE:")) {
            title = line.replace(/TITLE:/i, "").trim();
        } else if (line.toUpperCase().startsWith("Q:")) {
            if (currentQ) questions.push(currentQ);
            currentQ = {
                question: line.replace(/Q:/i, "").trim(),
                options: [],
                correctIndex: -1
            };
        } else if (line.toUpperCase().startsWith("A:")) {
            if (currentQ) {
                let answerText = line.replace(/A:/i, "").trim();
                const isCorrect = answerText.endsWith("*");
                if (isCorrect) {
                    answerText = answerText.slice(0, -1).trim();
                    currentQ.correctIndex = currentQ.options.length;
                }
                currentQ.options.push(answerText);
            }
        }
    });

    if (currentQ) questions.push(currentQ);

    return { title, questions };
}
