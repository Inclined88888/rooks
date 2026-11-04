import { Link } from "react-router-dom";
import { PRODUCT, PRODUCT_LINE } from "../product";

/** What Rooks is. Plain words, no setup steps. */
export default function About() {
  return (
    <div className="page" style={{ maxWidth: 640 }}>
      <div className="page-head">
        <div>
          <h1>About</h1>
          <p className="muted">{PRODUCT}. {PRODUCT_LINE}</p>
        </div>
      </div>
      <div className="card col" style={{ gap: 14 }}>
        <p style={{ margin: 0 }}>Rooks runs on this computer. Your mail, your files, and what it remembers stay here.</p>
        <p style={{ margin: 0 }}>Chat, mail, the browser, and the computer share one memory. A fact you save in one place is there in the others.</p>
        <p style={{ margin: 0 }}>It asks before it sends a mail or clicks on a page. Signing in is your turn.</p>
        <p style={{ margin: 0 }}>The model is the one you choose. A key you paste, a plan you already pay for, or a model on this computer.</p>
        <p style={{ margin: 0 }}>A phone you pair opens the same work. The work still lives here.</p>
      </div>
      <p className="small muted"><Link to="/privacy">Privacy</Link></p>
    </div>
  );
}
