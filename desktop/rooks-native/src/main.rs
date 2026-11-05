//! Rooks. Its own window. The local service does the work; this file only draws.

use std::time::Duration;

use iced::widget::{button, checkbox, column, container, row, scrollable, text, text_input};
use iced::{Alignment, Element, Length, Subscription, Task, Theme};

use rooks_native::copy::{self, BODY, HEADLINE, KICKER, PRODUCT};
use rooks_native::parse::{self, ConnectorRow, JobRow, MailRow, ModelRow, SkillRow, TaskRow};
use rooks_native::prefs::{self, Prefs};
use rooks_native::term::Term;
use rooks_native::{client::Client, link::Link};

fn main() -> iced::Result {
    iced::application(copy::window_title(), App::update, App::view)
        .subscription(App::subscription)
        .theme(App::theme)
        .window_size(iced::Size::new(1180.0, 760.0))
        .run_with(App::boot)
}

struct App {
    welcome: bool,
    screen: &'static str,
    client: Option<Client>,
    prefs: Prefs,
    banner: String,
    notices: Vec<String>,
    tasks: Vec<TaskRow>,
    task_draft: String,
    mail_label: String,
    mail: Vec<MailRow>,
    skills: Vec<SkillRow>,
    connectors: Vec<ConnectorRow>,
    models: Vec<ModelRow>,
    name: String,
    name_draft: String,
    terminal_line: String,
    term: Option<Term>,
    term_text: String,
    term_draft: String,
    browser: Vec<JobRow>,
    code: Vec<JobRow>,
}

#[derive(Debug, Clone)]
enum Message {
    Continue,
    Connected(Result<Link, String>),
    Go(&'static str),
    Notices(Result<Vec<String>, String>),
    Tasks(Result<Vec<TaskRow>, String>),
    TaskDraft(String),
    AddTask,
    Done(i64),
    Mail(Result<(String, Vec<MailRow>), String>),
    Skills(Result<Vec<SkillRow>, String>),
    AddSkill(String),
    Connectors(Result<Vec<ConnectorRow>, String>),
    Customize(Result<(String, Vec<ModelRow>), String>),
    Name(String),
    SaveName,
    Cloud(bool),
    Terminal(Result<String, String>),
    OpenTerm,
    TermDraft(String),
    TermSend,
    TermTick,
    Browser(Result<Vec<JobRow>, String>),
    AnswerBrowser {
        job: String,
        approval: String,
        approve: bool,
    },
    StopBrowser(String),
    Code(Result<Vec<JobRow>, String>),
    AnswerCode {
        id: String,
        approve: bool,
    },
    DoneOp(Result<(), String>),
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        (
            Self {
                welcome: true,
                screen: "workplace",
                client: None,
                prefs: prefs::load(),
                banner: String::new(),
                notices: Vec::new(),
                tasks: Vec::new(),
                task_draft: String::new(),
                mail_label: String::new(),
                mail: Vec::new(),
                skills: Vec::new(),
                connectors: Vec::new(),
                models: Vec::new(),
                name: String::new(),
                name_draft: String::new(),
                terminal_line: String::new(),
                term: None,
                term_text: String::new(),
                term_draft: String::new(),
                browser: Vec::new(),
                code: Vec::new(),
            },
            Task::none(),
        )
    }

    fn theme(_state: &Self) -> Theme {
        Theme::Light
    }

    fn subscription(state: &Self) -> Subscription<Message> {
        if state.term.is_some() {
            iced::time::every(Duration::from_millis(300)).map(|_| Message::TermTick)
        } else {
            Subscription::none()
        }
    }

    fn update(state: &mut Self, message: Message) -> Task<Message> {
        match message {
            Message::Continue => {
                state.banner = "Opening the local service…".into();
                Task::perform(async { rooks_native::link::ensure() }, Message::Connected)
            }
            Message::Connected(result) => match result {
                Ok(link) => {
                    state.banner.clear();
                    state.client = Some(Client::new(link.url, link.key, link.cookie));
                    state.welcome = false;
                    state.load("workplace")
                }
                Err(err) => {
                    state.banner = err;
                    Task::none()
                }
            },
            Message::Go(screen) => {
                state.screen = screen;
                state.load(screen)
            }
            Message::Notices(result) => state.take(result, |s, v| s.notices = v),
            Message::Tasks(result) => state.take(result, |s, v| s.tasks = v),
            Message::TaskDraft(value) => {
                state.task_draft = value;
                Task::none()
            }
            Message::AddTask => {
                state.with_client(|client, title| client.add_task(&title).map(|_| ()))
            }
            Message::Done(id) => state.with_client(move |client, _| client.complete_task(id)),
            Message::Mail(result) => state.take(result, |s, (label, rows)| {
                s.mail_label = label;
                s.mail = rows;
            }),
            Message::Skills(result) => state.take(result, |s, v| s.skills = v),
            Message::AddSkill(id) => state.with_client(move |client, _| client.add_skill(&id)),
            Message::Connectors(result) => state.take(result, |s, v| s.connectors = v),
            Message::Customize(result) => state.take(result, |s, (name, models)| {
                s.name = name.clone();
                s.name_draft = name;
                s.models = models;
            }),
            Message::Name(value) => {
                state.name_draft = value;
                Task::none()
            }
            Message::SaveName => {
                let name = state.name_draft.clone();
                state.with_client(move |client, _| client.save_assistant_name(&name))
            }
            Message::Cloud(on) => {
                state.prefs.send_prompts_to_provider = on;
                if let Err(err) = prefs::save(&state.prefs) {
                    state.banner = err;
                }
                state.load("customize")
            }
            Message::Terminal(result) => state.take(result, |s, line| s.terminal_line = line),
            Message::OpenTerm => {
                if let Some(client) = &state.client {
                    match Term::open(client.base(), client.cookie()) {
                        Ok(term) => state.term = Some(term),
                        Err(err) => state.terminal_line = err,
                    }
                }
                Task::none()
            }
            Message::TermDraft(value) => {
                state.term_draft = value;
                Task::none()
            }
            Message::TermSend => {
                if let Some(term) = &state.term {
                    term.send_line(&state.term_draft);
                    state.term_draft.clear();
                }
                Task::none()
            }
            Message::TermTick => {
                if let Some(term) = &state.term {
                    state.term_text = term.output();
                }
                Task::none()
            }
            Message::Browser(result) => state.take(result, |s, v| s.browser = v),
            Message::AnswerBrowser {
                job,
                approval,
                approve,
            } => {
                state.with_client(move |client, _| client.browser_answer(&job, &approval, approve))
            }
            Message::StopBrowser(job) => {
                state.with_client(move |client, _| client.browser_stop(&job))
            }
            Message::Code(result) => state.take(result, |s, v| s.code = v),
            Message::AnswerCode { id, approve } => {
                state.with_client(move |client, _| client.code_answer(&id, approve))
            }
            Message::DoneOp(result) => {
                if let Err(err) = result {
                    state.banner = err;
                    return Task::none();
                }
                state.banner.clear();
                state.task_draft.clear();
                state.load(state.screen)
            }
        }
    }

    fn take<T>(
        &mut self,
        result: Result<T, String>,
        apply: impl FnOnce(&mut Self, T),
    ) -> Task<Message> {
        match result {
            Ok(value) => {
                self.banner.clear();
                apply(self, value);
            }
            Err(err) => self.banner = err,
        }
        Task::none()
    }

    fn with_client(
        &self,
        call: impl FnOnce(&Client, String) -> Result<(), String> + Send + 'static,
    ) -> Task<Message> {
        let Some(client) = self.client.clone() else {
            return Task::none();
        };
        let draft = self.task_draft.clone();
        Task::perform(async move { call(&client, draft) }, Message::DoneOp)
    }

    fn load(&self, screen: &'static str) -> Task<Message> {
        let Some(client) = self.client.clone() else {
            return Task::none();
        };
        let allow = self.prefs.send_prompts_to_provider;
        match screen {
            "workplace" => Task::perform(async move { client.notices() }, Message::Notices),
            "tasks" => Task::perform(async move { client.tasks() }, Message::Tasks),
            "mail" => Task::perform(
                async move {
                    let accounts = client.accounts()?;
                    let Some(account) = accounts.into_iter().next() else {
                        return Ok((
                            "No mail is connected yet. Add it under Connectors.".into(),
                            Vec::new(),
                        ));
                    };
                    let rows = client.messages(account.id)?;
                    Ok((account.label, rows))
                },
                Message::Mail,
            ),
            "skills" => Task::perform(async move { client.skills() }, Message::Skills),
            "connectors" => Task::perform(async move { client.connectors() }, Message::Connectors),
            "customize" => Task::perform(
                async move {
                    let name = client.assistant_name()?;
                    let models = client.models(allow)?;
                    Ok((name, models))
                },
                Message::Customize,
            ),
            "terminal" => Task::perform(
                async move {
                    let (enabled, open, platform) = client.terminal_status()?;
                    Ok(parse::format_terminal(enabled, open, &platform))
                },
                Message::Terminal,
            ),
            "browser" => Task::perform(async move { client.browser_jobs() }, Message::Browser),
            "code" => Task::perform(async move { client.code_jobs() }, Message::Code),
            _ => Task::none(),
        }
    }

    fn view(state: &Self) -> Element<'_, Message> {
        if state.welcome {
            return state.welcome_view();
        }
        row![state.rail(), state.body()].into()
    }

    fn welcome_view(&self) -> Element<'_, Message> {
        let mut page = column![
            text(KICKER).size(14),
            text(PRODUCT).size(48),
            text(HEADLINE).size(22),
            text(BODY).size(16),
            button(text("Continue")).on_press(Message::Continue),
        ]
        .spacing(14)
        .align_x(Alignment::Center)
        .max_width(640);
        if !self.banner.is_empty() {
            page = page.push(text(&self.banner).size(14));
        }
        container(page)
            .width(Length::Fill)
            .height(Length::Fill)
            .center(Length::Fill)
            .into()
    }

    fn rail(&self) -> Element<'_, Message> {
        let mut items = column![text(PRODUCT).size(20)].spacing(6).padding(12);
        for (label, id) in copy::RAIL {
            let mut item = button(text(*label)).width(Length::Fill);
            if *id != self.screen {
                item = item.on_press(Message::Go(id));
            }
            items = items.push(item);
        }
        container(items).width(220).height(Length::Fill).into()
    }

    fn body(&self) -> Element<'_, Message> {
        let mut page = column![].spacing(12).padding(20);
        if !self.banner.is_empty() {
            page = page.push(text(&self.banner).size(14));
        }
        page = match self.screen {
            "workplace" => self.workplace(page),
            "customize" => self.customize(page),
            "skills" => self.skills(page),
            "connectors" => self.connectors(page),
            "mail" => self.mail(page),
            "tasks" => self.tasks(page),
            "terminal" => self.terminal(page),
            "browser" => self.jobs(page, &self.browser, true),
            "code" => self.jobs(page, &self.code, false),
            _ => page.push(text("That screen is not in this version.")),
        };
        scrollable(page)
            .width(Length::Fill)
            .height(Length::Fill)
            .into()
    }

    fn workplace<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Workplace").size(28));
        page = page.push(text("What Rooks noticed, and the three places you set it up.").size(16));
        page = page.push(
            row![
                button(text("Customize")).on_press(Message::Go("customize")),
                button(text("Skills")).on_press(Message::Go("skills")),
                button(text("Connectors")).on_press(Message::Go("connectors")),
            ]
            .spacing(8),
        );
        page = page.push(text(prefs::cloud_line(self.prefs.send_prompts_to_provider)).size(14));
        if self.notices.is_empty() {
            page = page.push(text("Nothing new right now.").size(16));
        }
        for line in &self.notices {
            page = page.push(text(line).size(16));
        }
        page
    }

    fn customize<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Customize").size(28));
        page = page.push(text("How Rooks works for you. This stays on this computer.").size(16));
        page = page.push(
            text_input("Name", &self.name_draft)
                .on_input(Message::Name)
                .on_submit(Message::SaveName),
        );
        page = page.push(button(text("Save name")).on_press(Message::SaveName));
        page = page.push(
            checkbox(
                prefs::cloud_line(self.prefs.send_prompts_to_provider),
                self.prefs.send_prompts_to_provider,
            )
            .on_toggle(Message::Cloud),
        );
        page = page.push(text("Models").size(20));
        if self.models.is_empty() {
            page = page.push(text("No model is connected yet. A model on this computer, or a cloud model after you allow it.").size(16));
        }
        for model in &self.models {
            page = page.push(text(format!("{} · {}", model.name, model.where_)).size(16));
        }
        page
    }

    fn skills<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Skills").size(28));
        page = page.push(
            text("Tricks it can use. Adding one still gets checked before it runs.").size(16),
        );
        if self.skills.is_empty() {
            page = page.push(text("No skills to show yet.").size(16));
        }
        for skill in &self.skills {
            let id = skill.id.clone();
            let mut line =
                row![text(format!("{} — {}", skill.name, skill.detail)).width(Length::Fill)]
                    .spacing(8);
            if skill.added {
                line = line.push(text("Added"));
            } else {
                line = line.push(button(text("Add")).on_press(Message::AddSkill(id)));
            }
            page = page.push(line);
        }
        page
    }

    fn connectors<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Connectors").size(28));
        page = page.push(
            text("Mail, models, and any tool server you added. Each one stays on this computer.")
                .size(16),
        );
        if self.connectors.is_empty() {
            page = page.push(text("Nothing is connected yet.").size(16));
        }
        for item in &self.connectors {
            let state = if item.on { "On" } else { "Off" };
            page = page.push(text(format!("{state} · {} — {}", item.name, item.detail)).size(16));
        }
        page
    }

    fn mail<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Mail").size(28));
        page = page.push(
            text("Sending still waits for you. This screen reads what is already here.").size(16),
        );
        if !self.mail_label.is_empty() {
            page = page.push(text(&self.mail_label).size(14));
        }
        if self.mail.is_empty() {
            page = page.push(text("No messages to show.").size(16));
        }
        for message in &self.mail {
            page = page.push(text(format!("{} — {}", message.from, message.subject)).size(16));
        }
        page
    }

    fn tasks<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Tasks").size(28));
        page = page.push(
            row![
                text_input("Add a task", &self.task_draft)
                    .on_input(Message::TaskDraft)
                    .on_submit(Message::AddTask),
                button(text("Add")).on_press(Message::AddTask),
            ]
            .spacing(8),
        );
        if self.tasks.is_empty() {
            page = page.push(text("No tasks yet.").size(16));
        }
        for task in &self.tasks {
            let mut line = row![text(format!(
                "{} · {}",
                task.title,
                if task.due.is_empty() {
                    task.status.clone()
                } else {
                    task.due.clone()
                }
            ))
            .width(Length::Fill)];
            if task.status != "done" {
                line = line.push(button(text("Done")).on_press(Message::Done(task.id)));
            }
            page = page.push(line);
        }
        page
    }

    fn terminal<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Terminal").size(28));
        page = page.push(text(&self.terminal_line).size(16));
        page = page.push(
            text("The browser and the code agent are separate. This is a shell on this computer.")
                .size(14),
        );
        if self.term.is_none() {
            page = page.push(button(text("Open a terminal")).on_press(Message::OpenTerm));
        } else {
            page = page.push(text(&self.term_text).size(14));
            page = page.push(
                row![
                    text_input("Type a command", &self.term_draft)
                        .on_input(Message::TermDraft)
                        .on_submit(Message::TermSend),
                    button(text("Send")).on_press(Message::TermSend),
                ]
                .spacing(8),
            );
        }
        page
    }

    fn jobs<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
        jobs: &'a [JobRow],
        browser: bool,
    ) -> iced::widget::Column<'a, Message> {
        let title = if browser { "Browser" } else { "Code" };
        let note = if browser {
            "Jobs the browser agent is doing. It drives a browser as a tool. This window is not that browser. It stops for you before a sign-in, a send, or a payment."
        } else {
            "Jobs in a folder. Nothing runs past a stop until you say so."
        };
        page = page.push(text(title).size(28));
        page = page.push(text(note).size(16));
        if jobs.is_empty() {
            page = page.push(text("Nothing running.").size(16));
        }
        for job in jobs {
            page = page.push(text(format!("{} · {}", job.title, job.status)).size(16));
            for stop in &job.checkpoints {
                let job_id = stop.job_id.clone();
                let approval = stop.approval_id.clone();
                page = page.push(text(&stop.summary).size(14));
                if browser && stop.approval_id != "run" {
                    let stop_id = job.id.clone();
                    page = page.push(
                        row![
                            button(text("Continue")).on_press(Message::AnswerBrowser {
                                job: job_id.clone(),
                                approval: approval.clone(),
                                approve: true
                            }),
                            button(text("Stop")).on_press(Message::AnswerBrowser {
                                job: job_id,
                                approval,
                                approve: false
                            }),
                            button(text("Cancel job")).on_press(Message::StopBrowser(stop_id)),
                        ]
                        .spacing(8),
                    );
                } else {
                    page = page.push(
                        row![
                            button(text("Continue")).on_press(Message::AnswerCode {
                                id: job_id.clone(),
                                approve: true
                            }),
                            button(text("Stop")).on_press(Message::AnswerCode {
                                id: job_id,
                                approve: false
                            }),
                        ]
                        .spacing(8),
                    );
                }
            }
        }
        page
    }
}
