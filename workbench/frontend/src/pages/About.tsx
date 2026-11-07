import { PRODUCT, PRODUCT_LINE } from "../product";
import { Page, Section } from "../ui";
import { ButtonLink } from "./settings/index";
import "./settings/settings.css";

/** What Rooks is. Plain words, no setup steps. */
export default function About() {
  return (
    <Page title="About" description={`${PRODUCT}. ${PRODUCT_LINE}`} className="st-page" actions={<ButtonLink size="sm" variant="ghost" to="/privacy">Privacy</ButtonLink>}>
      <Section>
        <ul className="st-about">
          <li>Rooks runs on this computer. Your mail, your files, and what it remembers stay here.</li>
          <li>Chat, mail, the browser, and the computer share one memory. A fact you save in one place is there in the others.</li>
          <li>It asks before it sends a mail or clicks on a page. Signing in is your turn.</li>
          <li>The model is the one you choose. A key you paste, a plan you already pay for, or a model on this computer.</li>
          <li>A phone you pair opens the same work. The work still lives here.</li>
        </ul>
      </Section>
    </Page>
  );
}
