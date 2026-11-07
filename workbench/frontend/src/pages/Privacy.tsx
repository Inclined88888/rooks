import { PRODUCT, PRODUCT_LINE } from "../product";
import { Page, Section } from "../ui";
import { ButtonLink } from "./settings";
import "./settings/settings.css";

/** Where the work lives, and the only times it leaves this computer. */
export default function Privacy() {
  return (
    <Page title="Privacy" description={`${PRODUCT}. ${PRODUCT_LINE}`} className="st-page" actions={<ButtonLink size="sm" variant="ghost" to="/about">About</ButtonLink>}>
      <Section title="The lock">
        <p className="st-p">A PIN or password you create keeps this copy to you. It is separate from Gmail, Apple, Microsoft, ChatGPT and Claude.</p>
      </Section>
      <Section title="What stays here">
        <p className="st-p">Mail you have already opened, calendar, tasks, notes, files, and what the assistant remembers are stored on this computer. Keys sit in this computer's keychain.</p>
      </Section>
      <Section title="What leaves">
        <p className="st-p">When you ask the assistant, that question goes to the model you picked. When you sign in to mail or a plan, that company's own window handles the sign-in. Rooks does not sell your work, and it does not send it anywhere except the model or account you chose.</p>
      </Section>
      <Section title="Remembering" actions={<ButtonLink size="sm" to="/about-you">About you</ButtonLink>}>
        <p className="st-p">Learning about you can be switched off on About you. What it has learned stays on this computer.</p>
      </Section>
      <Section title="A phone">
        <p className="st-p">A phone you pair can reach this computer. The work still lives here. Unpair it from Settings whenever you want.</p>
      </Section>
    </Page>
  );
}
