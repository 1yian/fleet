import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BoardPage } from "./BoardPage.tsx";
import "./board.css";

const root = document.getElementById("root");
if (root === null) throw new Error("index.html has no #root");
createRoot(root).render(
  <StrictMode>
    <BoardPage />
  </StrictMode>,
);
