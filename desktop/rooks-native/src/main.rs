//! Rooks. Its own window. The local service does the work; this file only draws.

use std::time::Duration;

use iced::widget::button::Status;
use iced::widget::{button, checkbox, column, container, row, scrollable, text, text_input};
use iced::{
    Alignment, Background, Border, Color, Element, Length, Shadow, Subscription, Task, Theme,
};

use rooks_native::copy::{self, BODY, HEADLINE, KICKER, PRODUCT};
use rooks_native::fit::{self, Profile, Suggestion};
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

#[derive(Clone, Copy, PartialEq, Eq)]
enum Step {
    Welcome,
    Role,
    Tools,
    Help,
}

struct App {
    step: Option<Step>,
    screen: &'static str,
    draft: Profile,
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
    Next,
    Back,
    PickRole(&'static str),
    ToggleTool(&'static str),
    ToggleHelp(&'static str),
    Connected(Result<Link, String>),
    Go(&'static str),
    Home((Vec<String>, Vec<TaskRow>)),
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

fn palette() -> iced::theme::Palette {
    iced::theme::Palette {
        background: Color::from_rgb(0.965, 0.953, 0.929),
        text: Color::from_rgb(0.12, 0.11, 0.09),
        primary: Color::from_rgb(0.18, 0.24, 0.21),
        success: Color::from_rgb(0.29, 0.45, 0.36),
        danger: Color::from_rgb(0.62, 0.32, 0.27),
    }
}

fn ink() -> Color {
    Color::from_rgb(0.18, 0.24, 0.21)
}

fn paper() -> Color {
    Color::from_rgb(0.99, 0.98, 0.96)
}

fn line() -> Color {
    Color::from_rgb(0.82, 0.78, 0.72)
}

fn card_style(on: bool) -> impl Fn(&Theme, Status) -> button::Style {
    move |theme: &Theme, _status: Status| button::Style {
        background: Some(Background::Color(if on {
            Color::from_rgb(0.90, 0.88, 0.83)
        } else {
            paper()
        })),
        text_color: theme.palette().text,
        border: Border {
            color: if on { ink() } else { line() },
            width: if on { 1.5 } else { 1.0 },
            radius: 12.0.into(),
        },
        shadow: Shadow::default(),
    }
}

fn nav_style(on: bool) -> impl Fn(&Theme, Status) -> button::Style {
    move |theme, status| {
        if on {
            button::Style {
                background: Some(Background::Color(Color::from_rgb(0.90, 0.88, 0.83))),
                text_color: theme.palette().text,
                border: Border {
                    color: ink(),
                    width: 1.0,
                    radius: 10.0.into(),
                },
                shadow: Shadow::default(),
            }
        } else {
            quiet_style(theme, status)
        }
    }
}

fn quiet_style(theme: &Theme, status: Status) -> button::Style {
    let base = button::text(theme, status);
    button::Style {
        text_color: theme.palette().text,
        ..base
    }
}

impl App {
    fn boot() -> (Self, Task<Message>) {
        let prefs = prefs::load();
        let known = prefs
            .profile
            .as_ref()
            .is_some_and(|profile| profile.ready());
        let app = Self {
            step: if known { None } else { Some(Step::Welcome) },
            screen: "home",
            draft: prefs.profile.clone().unwrap_or_default(),
            client: None,
            prefs,
            banner: String::new(),
            notices: Vec::new(),
            tasks: Vec::new(),
            task_draft: String::new(),
            mail_label: String::new(),
            mail: Vec::new(),
            skills: Vec::new(),
            connectors: Vec::new(),
            models: Vec::new(),
            name_draft: String::new(),
            terminal_line: String::new(),
            term: None,
            term_text: String::new(),
            term_draft: String::new(),
            browser: Vec::new(),
            code: Vec::new(),
        };
        let task = if known {
            Task::perform(async { rooks_native::link::ensure() }, Message::Connected)
        } else {
            Task::none()
        };
        (app, task)
    }

    fn theme(_state: &Self) -> Theme {
        Theme::custom("Rooks".to_string(), palette())
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
            Message::Next => match state.step {
                Some(Step::Welcome) => {
                    state.step = Some(Step::Role);
                    Task::none()
                }
                Some(Step::Role) if !state.draft.role.is_empty() => {
                    state.step = Some(Step::Tools);
                    Task::none()
                }
                Some(Step::Tools) => {
                    state.step = Some(Step::Help);
                    Task::none()
                }
                Some(Step::Help) if !state.draft.help.is_empty() => {
                    state.prefs.profile = Some(state.draft.clone());
                    if let Err(err) = prefs::save(&state.prefs) {
                        state.banner = err;
                        return Task::none();
                    }
                    state.step = None;
                    state.banner = "Opening the local service…".into();
                    Task::perform(async { rooks_native::link::ensure() }, Message::Connected)
                }
                _ => Task::none(),
            },
            Message::Back => {
                state.step = match state.step {
                    Some(Step::Role) => Some(Step::Welcome),
                    Some(Step::Tools) => Some(Step::Role),
                    Some(Step::Help) => Some(Step::Tools),
                    other => other,
                };
                Task::none()
            }
            Message::PickRole(id) => {
                state.draft.role = id.to_string();
                Task::none()
            }
            Message::ToggleTool(id) => {
                toggle(&mut state.draft.tools, id);
                Task::none()
            }
            Message::ToggleHelp(id) => {
                toggle(&mut state.draft.help, id);
                Task::none()
            }
            Message::Connected(result) => match result {
                Ok(link) => {
                    state.banner.clear();
                    state.client = Some(Client::new(link.url, link.key, link.cookie));
                    state.step = None;
                    state.load("home")
                }
                Err(err) => {
                    state.banner = err;
                    state.step = None;
                    Task::none()
                }
            },
            Message::Go(screen) => {
                state.screen = screen;
                state.load(screen)
            }
            Message::Home((notices, tasks)) => {
                state.notices = notices;
                state.tasks = tasks;
                state.banner.clear();
                Task::none()
            }
            Message::Notices(result) => state.take(result, |app, value| app.notices = value),
            Message::Tasks(result) => state.take(result, |app, value| app.tasks = value),
            Message::TaskDraft(value) => {
                state.task_draft = value;
                Task::none()
            }
            Message::AddTask => {
                if state.task_draft.trim().is_empty() {
                    return Task::none();
                }
                state.with_client(|client, title| client.add_task(&title).map(|_| ()))
            }
            Message::Done(id) => state.with_client(move |client, _| client.complete_task(id)),
            Message::Mail(result) => state.take(result, |app, (label, rows)| {
                app.mail_label = label;
                app.mail = rows;
            }),
            Message::Skills(result) => state.take(result, |app, value| app.skills = value),
            Message::AddSkill(id) => state.with_client(move |client, _| client.add_skill(&id)),
            Message::Connectors(result) => state.take(result, |app, value| app.connectors = value),
            Message::Customize(result) => state.take(result, |app, (name, models)| {
                app.name_draft = name;
                app.models = models;
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
            Message::Terminal(result) => state.take(result, |app, line| app.terminal_line = line),
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
            Message::Browser(result) => state.take(result, |app, value| app.browser = value),
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
            Message::Code(result) => state.take(result, |app, value| app.code = value),
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
                if !self.banner.starts_with("Opening") {
                    self.banner.clear();
                }
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
            "home" => Task::perform(
                async move {
                    let notices = client.notices().unwrap_or_default();
                    let tasks = client.tasks().unwrap_or_default();
                    (notices, tasks)
                },
                Message::Home,
            ),
            "tasks" => Task::perform(async move { client.tasks() }, Message::Tasks),
            "mail" => Task::perform(
                async move {
                    let accounts = client.accounts()?;
                    let Some(account) = accounts.into_iter().next() else {
                        return Ok(("No mail is connected yet.".into(), Vec::new()));
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
                    let name = client.assistant_name().unwrap_or_else(|_| "Atlas".into());
                    let models = client.models(allow).unwrap_or_default();
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
        if let Some(step) = state.step {
            return state.interview(step);
        }
        column![
            state.topbar(),
            row![state.rail(), state.body()].height(Length::Fill)
        ]
        .into()
    }

    fn interview(&self, step: Step) -> Element<'_, Message> {
        let (kicker, title, note) = match step {
            Step::Welcome => (KICKER, HEADLINE, BODY),
            Step::Role => (
                "About you · 1 of 3",
                "What is most of your day?",
                "One answer is enough. It shapes what Rooks suggests.",
            ),
            Step::Tools => (
                "About you · 2 of 3",
                "What do you already use?",
                "Pick any that are part of the work. You can add more later.",
            ),
            Step::Help => (
                "About you · 3 of 3",
                "Where should Rooks help first?",
                "These stay on this computer. Later launches skip these questions.",
            ),
        };
        let mut page = column![
            text(kicker).size(13),
            if step == Step::Welcome {
                text(PRODUCT).size(46)
            } else {
                text(title).size(30)
            },
        ]
        .spacing(12)
        .max_width(560);
        if step == Step::Welcome {
            page = page.push(text(title).size(22));
        }
        page = page.push(text(note).size(16));
        page = match step {
            Step::Welcome => page,
            Step::Role => self.choices(page, fit::ROLES, &self.draft.role, Message::PickRole),
            Step::Tools => self.many(page, fit::TOOLS, &self.draft.tools, Message::ToggleTool),
            Step::Help => self.many(page, fit::HELP, &self.draft.help, Message::ToggleHelp),
        };
        let mut actions = row![].spacing(12);
        if step != Step::Welcome {
            actions = actions.push(
                button(text("Back"))
                    .style(quiet_style)
                    .on_press(Message::Back),
            );
        }
        let ready = match step {
            Step::Role => !self.draft.role.is_empty(),
            Step::Help => !self.draft.help.is_empty(),
            _ => true,
        };
        let label = if step == Step::Help {
            "Show my workplace"
        } else {
            "Continue"
        };
        let mut next = button(text(label)).style(button::primary);
        if ready {
            next = next.on_press(Message::Next);
        }
        actions = actions.push(next);
        page = page.push(actions);
        if !self.banner.is_empty() {
            page = page.push(text(&self.banner).size(14));
        }
        container(page)
            .width(Length::Fill)
            .height(Length::Fill)
            .center(Length::Fill)
            .into()
    }

    fn choices<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
        options: &'static [(&str, &str)],
        current: &str,
        make: fn(&'static str) -> Message,
    ) -> iced::widget::Column<'a, Message> {
        for (id, label) in options {
            let on = current == *id;
            page = page.push(
                button(text(*label).size(16))
                    .width(Length::Fill)
                    .padding(14)
                    .style(card_style(on))
                    .on_press(make(id)),
            );
        }
        page
    }

    fn many<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
        options: &'static [(&str, &str)],
        current: &'a [String],
        make: fn(&'static str) -> Message,
    ) -> iced::widget::Column<'a, Message> {
        for (id, label) in options {
            let on = current.iter().any(|item| item == id);
            let mark = if on { "Selected · " } else { "" };
            page = page.push(
                button(text(format!("{mark}{label}")).size(16))
                    .width(Length::Fill)
                    .padding(14)
                    .style(card_style(on))
                    .on_press(make(id)),
            );
        }
        page
    }

    fn topbar(&self) -> Element<'_, Message> {
        let mut setup = row![].spacing(4);
        for (label, id) in copy::SETUP {
            let on = *id == self.screen;
            let mut item = button(text(*label).size(15))
                .padding([8, 12])
                .style(nav_style(on));
            if !on {
                item = item.on_press(Message::Go(id));
            }
            setup = setup.push(item);
        }
        container(
            row![
                text(PRODUCT).size(20),
                iced::widget::horizontal_space(),
                setup
            ]
            .align_y(Alignment::Center)
            .padding([14, 20]),
        )
        .width(Length::Fill)
        .style(|_theme| container::Style {
            background: Some(Background::Color(paper())),
            border: Border {
                color: line(),
                width: 1.0,
                radius: 0.0.into(),
            },
            ..container::Style::default()
        })
        .into()
    }

    fn rail(&self) -> Element<'_, Message> {
        let mut items = column![text("Work").size(12)].spacing(4).padding(16);
        for (label, id) in copy::SURFACES {
            if *id == "terminal" {
                items = items.push(text("Surfaces").size(12));
            }
            let on = *id == self.screen;
            let mut item = button(text(*label).size(15))
                .width(Length::Fill)
                .padding([8, 10])
                .style(nav_style(on));
            if !on {
                item = item.on_press(Message::Go(id));
            }
            items = items.push(item);
        }
        container(items).width(200).height(Length::Fill).into()
    }

    fn body(&self) -> Element<'_, Message> {
        let mut page = column![].spacing(14).padding([24, 28]);
        if !self.banner.is_empty() {
            page = page.push(text(&self.banner).size(14));
        }
        page = match self.screen {
            "home" => self.home(page),
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

    fn home<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        let profile = self.prefs.profile.clone().unwrap_or_default();
        let open = self
            .tasks
            .iter()
            .filter(|task| task.status != "done")
            .count();
        let has_work = !self.notices.is_empty() || open > 0;
        page = page.push(text("Home").size(30));
        page = page.push(text(fit::greeting(&profile)).size(16));
        page = page.push(text(fit::home_guide(has_work)).size(16));
        page = page.push(text("Suggested for you").size(18));
        for item in fit::suggestions(&profile).into_iter().take(4) {
            page = page.push(self.suggest_card(item));
        }
        if self.notices.is_empty() && open == 0 {
            page = page.push(text("No open tasks yet. When you add one, it will sit here with the rest of the day.").size(15));
        } else {
            page = page.push(text("Waiting").size(18));
            for line in &self.notices {
                page = page.push(text(line).size(16));
            }
            if open > 0 {
                page =
                    page.push(text(format!("{open} open tasks. They live under Tasks.")).size(15));
            }
        }
        page
    }

    fn suggest_card(&self, item: Suggestion) -> Element<'_, Message> {
        container(column![text(item.title).size(16), text(item.why).size(14)].spacing(4))
            .width(Length::Fill)
            .padding(14)
            .style(|_theme| container::Style {
                background: Some(Background::Color(paper())),
                border: Border {
                    color: line(),
                    width: 1.0,
                    radius: 12.0.into(),
                },
                ..container::Style::default()
            })
            .into()
    }

    fn customize<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Customize").size(30));
        page = page.push(text("How Rooks works for you. This stays on this computer.").size(16));
        page = page.push(
            text_input("Name", &self.name_draft)
                .on_input(Message::Name)
                .on_submit(Message::SaveName)
                .padding(12),
        );
        page = page.push(
            button(text("Save name"))
                .style(button::primary)
                .on_press(Message::SaveName),
        );
        page = page.push(
            checkbox(
                prefs::cloud_line(self.prefs.send_prompts_to_provider),
                self.prefs.send_prompts_to_provider,
            )
            .on_toggle(Message::Cloud),
        );
        page = page.push(text("Models").size(18));
        if self.models.is_empty() {
            page = page.push(text("No model is connected yet. One on this computer works without sending anything away. A cloud model waits until you allow it.").size(15));
        }
        for model in &self.models {
            page = page.push(text(format!("{} · {}", model.name, model.where_)).size(15));
        }
        page
    }

    fn skills<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        let profile = self.prefs.profile.clone().unwrap_or_default();
        page = page.push(text("Skills").size(30));
        page = page.push(
            text("For you, from what you said. Adding one is still checked before it runs.")
                .size(16),
        );
        for item in fit::for_group(&profile, "skill") {
            let added = self
                .skills
                .iter()
                .any(|skill| skill.id == item.id && skill.added);
            page = page.push(self.fit_row(item, added));
        }
        if self.skills.is_empty() {
            page = page.push(text("The skill list on this computer is not loaded yet. The suggestions above still stand.").size(15));
        } else {
            page = page.push(text("On this computer").size(18));
            for skill in &self.skills {
                let id = skill.id.clone();
                let mut line =
                    row![text(format!("{} — {}", skill.name, skill.detail)).width(Length::Fill)]
                        .spacing(8);
                if skill.added {
                    line = line.push(text("Added"));
                } else {
                    line = line.push(
                        button(text("Add"))
                            .style(quiet_style)
                            .on_press(Message::AddSkill(id)),
                    );
                }
                page = page.push(line);
            }
        }
        page
    }

    fn fit_row(&self, item: Suggestion, added: bool) -> Element<'_, Message> {
        let mut row = row![column![text(item.title).size(16), text(item.why).size(14)]
            .spacing(2)
            .width(Length::Fill)]
        .spacing(8)
        .align_y(Alignment::Center);
        if item.group == "skill" {
            if added {
                row = row.push(text("Added"));
            } else if !item.id.is_empty() {
                let id = item.id.to_string();
                row = row.push(
                    button(text("Add"))
                        .style(button::primary)
                        .on_press(Message::AddSkill(id)),
                );
            }
        }
        container(row)
            .width(Length::Fill)
            .padding(14)
            .style(|_theme| container::Style {
                background: Some(Background::Color(paper())),
                border: Border {
                    color: line(),
                    width: 1.0,
                    radius: 12.0.into(),
                },
                ..container::Style::default()
            })
            .into()
    }

    fn connectors<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        let profile = self.prefs.profile.clone().unwrap_or_default();
        page = page.push(text("Connectors").size(30));
        page = page.push(
            text("Suggested from what you already use. Each one stays on this computer.").size(16),
        );
        for item in fit::for_group(&profile, "connector") {
            let on = self
                .connectors
                .iter()
                .any(|row| row.name.eq_ignore_ascii_case(item.title) && row.on);
            page = page.push(
                text(format!(
                    "{} — {}{}",
                    item.title,
                    item.why,
                    if on { " On." } else { "" }
                ))
                .size(15),
            );
        }
        if self.connectors.is_empty() {
            page = page.push(text("Nothing else is connected yet. When the local service is up, mail and tool servers show here too.").size(15));
        } else {
            page = page.push(text("Connected").size(18));
            for item in &self.connectors {
                let state = if item.on { "On" } else { "Off" };
                page =
                    page.push(text(format!("{state} · {} — {}", item.name, item.detail)).size(15));
            }
        }
        page
    }

    fn mail<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Mail").size(30));
        page = page.push(
            text("Sending still waits for you. This screen reads what is already here.").size(16),
        );
        if !self.mail_label.is_empty() {
            page = page.push(text(&self.mail_label).size(14));
        }
        if self.mail.is_empty() {
            page = page.push(text("No messages yet. If mail is part of your day, connect it and the inbox will show here.").size(15));
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
        page = page.push(text("Tasks").size(30));
        page = page.push(
            row![
                text_input("Add a task", &self.task_draft)
                    .on_input(Message::TaskDraft)
                    .on_submit(Message::AddTask)
                    .padding(12),
                button(text("Add"))
                    .style(button::primary)
                    .on_press(Message::AddTask),
            ]
            .spacing(8),
        );
        if self.tasks.is_empty() {
            page = page
                .push(text("Nothing is due. Add a task when you want it kept in view.").size(15));
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
                line = line.push(
                    button(text("Done"))
                        .style(quiet_style)
                        .on_press(Message::Done(task.id)),
                );
            }
            page = page.push(line);
        }
        page
    }

    fn terminal<'a>(
        &'a self,
        mut page: iced::widget::Column<'a, Message>,
    ) -> iced::widget::Column<'a, Message> {
        page = page.push(text("Terminal").size(30));
        page = page.push(text(&self.terminal_line).size(16));
        if self.term.is_none() {
            page = page.push(
                button(text("Open a terminal"))
                    .style(button::primary)
                    .on_press(Message::OpenTerm),
            );
        } else {
            page = page.push(text(&self.term_text).size(14));
            page = page.push(
                row![
                    text_input("Type a command", &self.term_draft)
                        .on_input(Message::TermDraft)
                        .on_submit(Message::TermSend)
                        .padding(12),
                    button(text("Send"))
                        .style(button::primary)
                        .on_press(Message::TermSend),
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
            "A job on a site. The browser is a tool. This window is not that browser. It stops before a sign-in, a send, or a payment."
        } else {
            "A job in a folder. Nothing runs past a stop until you say so."
        };
        page = page.push(text(title).size(30));
        page = page.push(text(note).size(16));
        if jobs.is_empty() {
            page = page.push(text(if browser {
                "No site is open. When a job is waiting for you, Continue and Stop will sit here."
            } else {
                "No code job is running. When one needs a yes, it will wait here."
            }).size(15));
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
                            button(text("Continue")).style(button::primary).on_press(
                                Message::AnswerBrowser {
                                    job: job_id.clone(),
                                    approval: approval.clone(),
                                    approve: true
                                }
                            ),
                            button(text("Stop")).style(quiet_style).on_press(
                                Message::AnswerBrowser {
                                    job: job_id,
                                    approval,
                                    approve: false
                                }
                            ),
                            button(text("Cancel job"))
                                .style(quiet_style)
                                .on_press(Message::StopBrowser(stop_id)),
                        ]
                        .spacing(8),
                    );
                } else {
                    page = page.push(
                        row![
                            button(text("Continue")).style(button::primary).on_press(
                                Message::AnswerCode {
                                    id: job_id.clone(),
                                    approve: true
                                }
                            ),
                            button(text("Stop"))
                                .style(quiet_style)
                                .on_press(Message::AnswerCode {
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

fn toggle(list: &mut Vec<String>, id: &str) {
    if let Some(index) = list.iter().position(|item| item == id) {
        list.remove(index);
    } else {
        list.push(id.to_string());
    }
}
