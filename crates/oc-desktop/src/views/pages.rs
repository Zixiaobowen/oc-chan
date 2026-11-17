use super::*;
impl RootView {
    pub(super) fn detail_panel(&self,width:f32,progress:f32,cx:&mut Context<Self>)->AnyElement{
        let schedule=self.page==AppPage::Schedules;
        let interactive=self.selection.is_some();self.inert_detail.set(!interactive);self.building_detail.set(true);
        let content=if schedule{self.schedule_detail(cx)}else{self.agent_detail(cx)};
        let panel=div().id("detail-panel").occlude().absolute().right(px(-width*(1.-progress))).top_0().bottom_0().w(px(width)).max_w_full().flex().flex_col().bg(rgb(self.palette().surface)).border_l_1().border_color(rgb(self.palette().line))
            .child(self.toolbar().flex_shrink_0().p_4().border_b_1().border_color(rgb(self.palette().line)).child(div().flex_1().font_weight(FontWeight::SEMIBOLD).child(if schedule{self.t("任务详情","Schedule details")}else{self.t("Agent 详情","Agent details")})).child(self.button(if schedule{"job-close"}else{"close-agent"},self.t("关闭详情","Close details"),Action::CloseDetail,true,cx)))
            .child(div().id("detail-content").flex_1().min_h_0().when(interactive,|el|el.overflow_y_scroll()).when(!interactive,|el|el.overflow_hidden()).track_scroll(&self.detail_scroll).p_4().child(content));
        self.inert_detail.set(false);self.building_detail.set(false);
        self.mark_bounds("detail-panel",panel,cx).into_any_element()
    }
    pub(super) fn overview(&self,cx:&mut Context<Self>)->AnyElement{
        let mut body=div().flex().flex_col().gap_2();
        body=body.child(self.status(&self.monitor.agents,self.settings.as_ref().is_some_and(|s|s.settings.plugins.agents)));
        if let Some(data)=&self.monitor.agents.data{
            body=body.child(self.row(self.t("主 Agent","Main agents"),data.agents.iter().filter(|a|a.kind==AgentKind::Main).count().to_string()))
                .child(self.row(self.t("确认活动的子代理","Confirmed active subagents"),data.active_subagent_count.map(|n|n.to_string()).unwrap_or_else(||self.t("未知","Unknown").into())));
            let mut agents=self.section(self.t("最近 Agent","Agents"));for agent in data.agents.iter().take(5){agents=agents.child(self.button(format!("preview-agent-{}",agent.id),format!("{} · {} · {}",agent.name,agent.runtime,agent.summary.as_deref().unwrap_or("—")),Action::Navigate(NavigationTarget::agent(agent)),true,cx));}body=body.child(agents);
        }
        if let Some(data)=&self.monitor.schedules.data{let mut jobs=self.section(format!("{} · {}",self.t("定时任务","Schedules"),data.jobs.len()));for job in data.jobs.iter().take(4){jobs=jobs.child(self.button(format!("preview-job-{}",job.id),format!("{} · {}",job.name,job.schedule),Action::Navigate(NavigationTarget::schedule(job)),true,cx));}body=body.child(jobs);}
        if let Some(data)=&self.monitor.system.data{body=body.child(self.section(self.t("本机资源","Machine resources")).child(self.row("CPU",percent(data.cpu_percent))).child(self.row(self.t("内存","Memory"),format!("{} / {}",bytes(data.memory_used),bytes(data.memory_total)))).child(self.row(self.t("磁盘","Disk"),format!("{} / {}",data.disk_used.map(bytes).unwrap_or_else(||"—".into()),data.disk_total.map(bytes).unwrap_or_else(||"—".into())))).child(self.row(self.t("开机时间","Uptime"),format!("{:.1} h",data.uptime_seconds/3600.))).child(self.note(format!("{} · {} · {}",data.hostname,data.cpu_model,data.os_version))));}
        body.child(self.button("overview-sources",self.t("查看来源与限制","View sources and limitations"),Action::Navigate(NavigationTarget::Page{page:AppPage::Sources}),true,cx)).into_any_element()
    }
    pub(super) fn agents(&self,_cx:&mut Context<Self>)->AnyElement{
        div().flex().flex_col().gap_3().child(self.search_input()).child(self.status(&self.monitor.agents,self.settings.as_ref().is_some_and(|s|s.settings.plugins.agents))).child(div().h(px(510.)).child(self.topology.clone())).into_any_element()
    }
    fn agent_detail(&self,cx:&mut Context<Self>)->AnyElement{
        let mut body=div();
        if let Some(target @ NavigationTarget::Agent{id,..})=self.detail_target(){
            let current=self.monitor.agents.data.as_ref().and_then(|s|s.agents.iter().find(|a|&a.id==id));
            let mut details=div().flex().flex_col().gap_3();
            if let Some(agent)=current.filter(|a|NavigationTarget::agent(a)==*target){
                if !self.search.read(cx).text.is_empty(){details=details.child(self.note(self.t("已保留搜索条件；目标可能被筛选遮挡，清除搜索后可在画布中查看。","Search is preserved; the target may be filtered out. Clear search to reveal it on the canvas.")));}
                details=details.child(self.row(self.t("名称","Name"),agent.name.clone())).child(self.row(self.t("工作摘要","Summary"),agent.summary.clone().unwrap_or_else(||"—".into())))
                    .child(self.row(self.t("角色 / 状态","Role / State"),format!("{} / {}",self.label(agent.kind),self.label(agent.state)))).child(self.row("PID",agent.pid.to_string())).child(self.row(self.t("运行时","Runtime"),agent.runtime.clone()))
                    .child(self.row(self.t("模型","Model"),agent.model.clone().unwrap_or_else(||"—".into()))).child(self.row(self.t("工作目录","Working directory"),agent.cwd.clone().unwrap_or_else(||"—".into())))
                    .child(self.row(self.t("父 Agent","Parent agent"),agent.parent_id.clone().unwrap_or_else(||"—".into()))).child(self.row("CPU",percent(agent.cpu_percent)))
                    .child(self.row(self.t("内存","Memory"),agent.memory_bytes.map(bytes).unwrap_or_else(||"—".into())));
                if let Some(activity)=&agent.activity{details=details.child(self.row(self.t("近 6 秒活动","Activity in the last 6 seconds"),format!("{} · {} · {}",self.label(activity.kind),activity.name.as_deref().unwrap_or("—"),activity.observed_at)));}
                details=details.child(self.note(self.t("工作中表示近期工具或模型调用证据；进程运行中仅表示进程可见。保留快照不代表当前活动。","Working means recent tool or model evidence. Running means the process is visible. Retained snapshots do not prove current activity.")));
                let sources=self.monitor.agents.data.as_ref().map(|snapshot|snapshot.sources.as_slice()).unwrap_or(&[]);
                if let Some(source)=sources.iter().find(|source|agent_status_source(agent)==Some(source.id.as_str())){
                    details=details.child(self.button(format!("agent-source-{}",source.id),format!("{} · {}",self.t("查看状态来源","View status source"),source.label),Action::Navigate(NavigationTarget::Source{id:source.id.clone(),section:MonitorSection::Agents}),true,cx));
                }else{details=details.child(self.note(self.t("当前快照中未识别到可定位的状态来源，无法提供来源链接。","No confirmed status source exists in the current snapshot; no source link is available.")));}
                if agent.tern.is_some(){details=details.child(self.button("agent-tern",self.t("在 Tern 中定位","Focus in Tern"),Action::Command("monitor_focus_agent_in_tern",json!({"agentId":agent.id})),!self.paused&&self.monitor.agents.error.is_none(),cx));}
            }else{details=details.child(self.note(self.t("此 Agent 已退出或身份已改变；不会显示复用 ID 的另一个实体。","This agent has exited or changed identity. Another entity reusing its ID is not shown.")));}body=body.child(details);
        }body.into_any_element()
    }
    fn chips(&self,key:&'static str,options:&[(&str,&str)],cx:&mut Context<Self>)->AnyElement{self.toolbar().children(options.iter().enumerate().map(|(i,(zh,en))|self.button(format!("{key}-{i}"),format!("{}{}",if self.filter(key)==i{"• "}else{""},self.t(zh,en)),Action::Filter(key,i),true,cx))).into_any_element()}
    pub(super) fn schedule_matches(&self,job:&ScheduledJob,cx:&Context<Self>)->bool{
        if self.filter("job-kind")==0&&!matches!(job.kind,JobKind::Calendar|JobKind::Interval)||self.filter("job-kind")==1&&!matches!(job.kind,JobKind::Service|JobKind::Startup){return false;}
        if match self.filter("job-scope"){1=>job.origin!=JobOrigin::Personal,2=>job.scope!=JobScope::User,3=>job.scope!=JobScope::System,_=>false}{return false;}
        if self.filter("job-state")>0&&[JobState::Running,JobState::Waiting,JobState::Disabled,JobState::Unloaded,JobState::Unknown][self.filter("job-state")-1]!=job.state{return false;}
        format!("{} {} {}",job.name,job.schedule,job.source).to_lowercase().contains(&self.search.read(cx).text.to_lowercase())
    }
    pub(super) fn schedules(&self,cx:&mut Context<Self>)->AnyElement{
        let mut body=div().flex().flex_col().gap_3().child(self.search_input())
            .child(self.chips("job-kind",&[("定时任务","Scheduled"),("服务与启动项","Services & startup"),("全部","All")],cx))
            .child(self.chips("job-scope",&[("全部范围","All scopes"),("个人配置","Personal"),("当前用户","Current user"),("系统","System")],cx))
            .child(self.chips("job-state",&[("全部状态","All states"),("运行","Running"),("等待","Waiting"),("停用","Disabled"),("未加载","Unloaded"),("未知","Unknown")],cx))
            .child(self.status(&self.monitor.schedules,self.settings.as_ref().is_some_and(|s|s.settings.plugins.schedules)));
        if let Some(data)=&self.monitor.schedules.data{let mut count=0;for job in &data.jobs{
            if !self.schedule_matches(job,cx){continue;}count+=1;
            body=body.child(self.button(format!("job-{}",job.id),format!("{}  ·  {}  ·  {}",job.name,self.label(job.state),job.schedule),Action::Navigate(NavigationTarget::schedule(job)),true,cx));
        }if count==0{body=body.child(self.note(self.t("没有符合条件的任务","No schedules match these filters")));}}
        body.into_any_element()
    }
    fn schedule_detail(&self,cx:&mut Context<Self>)->AnyElement{
        let mut body=div();
        if let Some(target @ NavigationTarget::Schedule{id,..})=self.detail_target(){
            let mut detail=div().flex().flex_col().gap_3();
            if let Some(job)=self.monitor.schedules.data.as_ref().and_then(|s|s.jobs.iter().find(|j|&j.id==id)).filter(|j|NavigationTarget::schedule(j)==*target){
                if !self.schedule_matches(job,cx){detail=detail.child(self.note(self.t("此任务不在当前筛选结果中；已保留筛选条件，可清除筛选后定位。","This schedule is outside the current filters. Filters are preserved; clear them to reveal it.")));}
                detail=detail.child(self.row(self.t("名称","Name"),job.name.clone()))
                    .child(self.row(self.t("计划","Schedule"),job.schedule.clone())).child(self.row(self.t("作用范围 / 来源类型","Scope / Origin"),format!("{} / {}",self.label(job.scope),self.label(job.origin))))
                    .child(self.row(self.t("配置路径","Configuration"),job.file.clone().unwrap_or_else(||"—".into())))
                    .child(self.schedule_configuration(id,cx))
                    .child(div().pt_3().font_weight(FontWeight::SEMIBOLD).child(self.t("运行状态","Execution status")))
                    .child(self.row(self.t("状态","State"),format!("{} · {}",self.label(job.state),self.label(job.state_reason))))
                    .child(self.row(self.t("程序","Executable"),job.executable.clone().unwrap_or_else(||"—".into())))
                    .child(self.row("PID",job.pid.map(|n|n.to_string()).unwrap_or_else(||"—".into()))).child(self.row(self.t("下次运行","Next run"),job.next_run.clone().unwrap_or_else(||"—".into())))
                    .child(self.row(self.t("最近退出码","Last exit code"),job.last_exit_code.map(|n|n.to_string()).unwrap_or_else(||"—".into())));
                if let Some(run)=&job.last_run{detail=detail.child(self.row(self.t("最近执行","Last execution"),format!("{} · {}",self.label(run.result),run.at.as_deref().unwrap_or("—"))));}
                let sources=self.monitor.schedules.data.as_ref().map(|snapshot|snapshot.sources.as_slice()).unwrap_or(&[]);
                let mut linked=false;
                for source in sources.iter().filter(|source|job_has_source(job,&source.id)){
                    linked=true;detail=detail.child(self.button(format!("job-source-{}",source.id),format!("{} · {}",self.t("查看任务来源","View task source"),source.label),Action::Navigate(NavigationTarget::Source{id:source.id.clone(),section:MonitorSection::Schedules}),true,cx));
                }
                if !linked{detail=detail.child(self.note(self.t("当前快照中未识别到可定位的任务来源，无法确认其状态与历史能力。","No confirmed task source exists in the current snapshot. Status and history capabilities are unconfirmed.")));}
                if job.id.starts_with("crontab:"){detail=detail.child(self.note(self.t("crontab 仅提供调度配置，不能确认任务正在运行，也不提供逐次执行历史。","crontab provides schedule configuration only, not current execution evidence or per-run history.")));}
                if job.source=="OMP 任务 · 未发现 launchd 配置"||job.source=="launchd · OMP 任务"{detail=detail.child(self.note(self.t("OMP 元数据说明任务配置，不代表任务已执行。","OMP metadata describes task configuration; it does not prove execution.")));}
                if job.id.starts_with("launchd:"){detail=detail.child(self.note(self.t("launchd 当前状态与最近退出码不提供逐次执行历史；用户任务未标明具体域时，链接列出实际采集到的用户域。","Current launchd status and the last exit code do not provide per-run history. When the user domain is unspecified, links list the collected user domains.")));}
                if job.id.starts_with("hermes-job:"){let subscribed=self.settings.as_ref().is_some_and(|s|s.settings.notifications.tasks.contains(target));detail=detail.child(self.button("subscribe-job",if subscribed{self.t("取消任务通知订阅","Unsubscribe task notifications")}else{self.t("订阅任务通知","Subscribe task notifications")},Action::Subscribe(target.clone()),true,cx));}
                detail=detail.child(self.note(self.t("任务为只读。历史中的执行中状态 不等于实时进程仍在运行。","Schedules are read-only. A running history record does not prove the process is still alive."))).child(self.button("history-refresh",self.t("刷新执行历史","Refresh execution history"),Action::History(self.history.as_ref().map(|h|h.offset).unwrap_or(0)),!self.busy("monitor_schedule_history"),cx));
                if self.busy("monitor_schedule_history"){detail=detail.child(self.note(self.t("正在读取历史…","Loading execution history…")));}
                if let Some(error)=self.requests.get("monitor_schedule_history").and_then(|r|r.error.as_ref()){detail=detail.child(self.note(error.clone()));}
                if let Some(history)=&self.history{if history.source==HistorySource::Unavailable{detail=detail.child(self.note(self.t("此来源不提供逐次执行历史","This source does not provide execution history")));}for run in &history.entries{detail=detail.child(self.row(format!("{} / {}",self.label(run.status),self.label(run.delivery)),format!("{}\n{}: {}\n{}: {}",run.claimed_at,self.t("开始","Started"),run.started_at.as_deref().unwrap_or("—"),self.t("结束","Finished"),run.finished_at.as_deref().unwrap_or("—"))));}detail=detail.child(self.toolbar().child(self.button("history-prev",self.t("上一页","Previous"),Action::History(history.offset.saturating_sub(HISTORY_PAGE_SIZE)),history.offset>0&&!self.busy("monitor_schedule_history"),cx)).child(self.note(format!("{}–{}",history.offset+1,history.offset+history.entries.len()))).child(self.button("history-next",self.t("下一页","Next"),Action::History(history.offset+HISTORY_PAGE_SIZE),history.has_more&&history.offset+HISTORY_PAGE_SIZE<=MAX_HISTORY_OFFSET&&!self.busy("monitor_schedule_history"),cx)));}
            }else{detail=detail.child(self.note(self.t("任务已移除或身份发生改变","This schedule was removed or changed identity")));}body=body.child(detail);
        }body.into_any_element()
    }
    fn schedule_configuration(&self,id:&str,cx:&mut Context<Self>)->AnyElement{
        let busy=self.busy("monitor_schedule_detail")||self.deferred_queries.contains_key("monitor_schedule_detail");
        let error=self.requests.get("monitor_schedule_detail").and_then(|request|request.error.as_ref());
        let mut section=div().w_full().min_w_0().flex().flex_col().gap_2().pt_3()
            .child(self.toolbar().child(div().flex_1().font_weight(FontWeight::SEMIBOLD).child(self.t("任务配置","Task configuration")))
                .child(self.button("schedule-detail-refresh",if error.is_some(){self.t("重试读取配置","Retry configuration")}else{self.t("刷新配置","Refresh configuration")},Action::ScheduleDetail,self.schedule_detail_allowed()&&!busy,cx)));
        if self.paused{section=section.child(self.note(self.t("监控已暂停；恢复后读取任务配置。","Monitoring is paused. Configuration loads when resumed.")));}
        else if !self.settings.as_ref().is_some_and(|s|s.settings.plugins.schedules){section=section.child(self.note(self.t("定时任务采集已关闭；启用后读取任务配置。","Schedule collection is disabled. Enable it to read configuration.")));}
        if busy{section=section.child(self.note(self.t("正在读取任务配置…","Loading task configuration…")));}
        if let Some(error)=error{section=section.child(self.note(error.clone()));}
        if let Some(config)=self.schedule_config.as_ref().filter(|config|config.job_id==id){
            section=section.child(self.note(format!("{} · {}",self.t("读取时间","Read at"),config.collected_at)));
            if config.fields.is_empty(){section=section.child(self.note(self.t("此来源未提供可显示的任务配置。","This source provided no task configuration fields.")));}
            for field in &config.fields{
                let key=format!("schedule-field-{}",field.key);
                let row=div().id(SharedString::from(key.clone())).relative().w_full().min_w_0().flex().flex_col().gap_1().py_2().border_b_1().border_color(rgb(self.palette().line))
                    .child(div().text_sm().text_color(rgb(self.palette().muted)).child(self.schedule_field_label(&field.key).to_owned()))
                    .child(div().w_full().min_w_0().whitespace_normal().child(if field.value.is_empty(){self.t("未填写","Not specified").to_owned()}else{field.value.clone()}));
                section=section.child(self.mark_bounds(&key,row,cx));
            }
            for note in &config.notes{section=section.child(self.note(note.clone()));}
        }else if !busy&&error.is_none()&&self.schedule_detail_allowed(){section=section.child(self.note(self.t("尚未读取任务配置，请刷新配置。","Task configuration has not been loaded. Refresh configuration to read it.")));}
        section.into_any_element()
    }
    fn schedule_field_label<'a>(&self,key:&'a str)->&'a str{let (zh,en)=match key{
        "configurationFile"=>("配置文件","Configuration file"),"metadataFile"=>("元数据文件","Metadata file"),
        "prompt"=>("任务正文","Task prompt"),"command"=>("执行命令","Command"),"program"=>("程序","Program"),"argv"=>("程序参数","Arguments"),
        "launchdArguments"=>("launchd 程序参数","launchd program arguments"),
        "cwd"=>("工作目录","Working directory"),"model"=>("模型","Model"),"provider"=>("模型提供商","Provider"),
        "workdir"=>("Hermes 工作目录","Hermes working directory"),"workingDirectory"=>("launchd 工作目录","launchd working directory"),
        "script"=>("脚本","Script"),"interpreter"=>("解释器","Interpreter"),"noAgent"=>("不使用 Agent","No agent"),"monitorScript"=>("监控脚本","Monitor script"),
        "skills"=>("技能列表","Skills"),"skill"=>("技能","Skill"),"repeatCompleted"=>("已重复次数","Completed repetitions"),"repeatTimes"=>("重复次数","Repetitions"),
        "schedule"=>("调度规则","Schedule rule"),"calendar"=>("日历计划","Calendar"),"timezone"=>("时区","Time zone"),"notBefore"=>("最早执行时间","Not before"),"originalSchedule"=>("原始调度规则","Original schedule"),
        "defaultTimezone"=>("默认时区","Default time zone"),"metadataNotBefore"=>("元数据最早执行时间","Metadata not before"),
        "enabled"=>("是否启用","Enabled"),"state"=>("配置状态","Configured state"),"startInterval"=>("启动间隔","Start interval"),"startCalendarInterval"=>("日历启动条件","Calendar start conditions"),
        "runAtLoad"=>("加载时运行","Run at load"),"keepAlive"=>("保持运行","Keep alive"),"standardInPath"=>("标准输入路径","Standard input path"),"standardOutPath"=>("标准输出路径","Standard output path"),"standardErrorPath"=>("标准错误路径","Standard error path"),
        _=>return key,
    };self.t(zh,en)}
    pub(super) fn events(&self,cx:&mut Context<Self>)->AnyElement{
        let mut body=div().flex().flex_col().gap_3().child(self.source_search.clone())
            .child(self.chips("event-type",&[("全部类型","All types"),("执行失败","Execution failed"),("投递失败","Delivery failed"),("来源不可用","Source unavailable"),("来源恢复","Source recovered")],cx))
            .child(self.chips("event-time",&[("全部时间","All time"),("1 小时","1 hour"),("24 小时","24 hours"),("7 天","7 days")],cx))
            .child(self.toolbar().child(self.button("events-apply",self.t("应用筛选","Apply filters"),Action::EventsApply,!self.busy("monitor_events"),cx)).child(self.button("events-clear",self.t("清除 / 查看最新","Clear / Latest"),Action::EventsClear,true,cx)).child(self.button("events-refresh",self.t("刷新本页 / 重试","Refresh page / Retry"),Action::Command("monitor_events",json!({"query":self.event_query})),!self.busy("monitor_events"),cx)))
            .child(self.status(&self.monitor.events,self.settings.as_ref().is_some_and(|s|s.settings.plugins.events)));
        if self.busy("monitor_events"){body=body.child(self.note(self.t("正在查询事件…","Querying events…")));}
        if let Some(page)=&self.event_page{
            if self.monitor.events.data.as_ref().is_some_and(|s|s.revision!=page.revision){body=body.child(self.note(self.t("记录已变化：可能有新事件或旧记录被清理。点击查看最新。","Records changed: new events may exist or older records were removed. Select Latest.")));}
            body=body.child(self.note(format!("{} {} · {} {} · {}",self.t("保留记录","Retained"),page.retention.count,self.t("已清理","Removed"),page.retention.deleted_count,bytes(page.retention.disk_bytes))));
            if page.entries.is_empty(){body=body.child(self.note(self.t("当前条件下没有事件","No events match the applied filters")));}
            for event in &page.entries{let mut row=div().py_3().border_b_1().border_color(rgb(self.palette().line)).flex().flex_col().gap_2().child(format!("{} · {}",self.label(event.event_type),event.result_code)).child(self.note(format!("{}: {} · {}: {}",self.t("发现","Observed"),event.observed_at,self.t("发生","Occurred"),event.occurred_at.as_deref().unwrap_or("—"))));if let Some(target)=&event.target{row=row.child(self.button(format!("event-target-{}",event.id),event.entity_id.clone(),Action::Navigate(target.clone()),true,cx));}row=row.child(self.button(format!("event-source-{}",event.id),event.source_id.clone(),Action::Navigate(NavigationTarget::Source{id:event.source_id.clone(),section:MonitorSection::Events}),true,cx));body=body.child(row);}
            body=body.child(self.toolbar().child(self.button("event-prev",self.t("上一页","Previous"),Action::EventsPrevious,!self.event_stack.is_empty()&&!self.busy("monitor_events"),cx)).child(self.button("event-next",self.t("下一页","Next"),Action::EventsNext,page.next.is_some()&&!self.busy("monitor_events"),cx)));
            let mut coverage=self.section(self.t("覆盖与断档","Coverage and gaps"));for source in &page.coverage{coverage=coverage.child(self.row(source.source_id.clone(),format!("{} · {}",self.label(source.state),source.code.as_deref().unwrap_or("—"))));if let Some(gap)=&source.last_gap{coverage=coverage.child(self.note(format!("{} – {} · {} · {}",gap.from,gap.to,gap.code,gap.count)));}}body=body.child(coverage);
        }body.into_any_element()
    }
    pub(super) fn system(&self,cx:&mut Context<Self>)->AnyElement{
        let mut body=div().flex().flex_col().gap_2().child(self.status(&self.monitor.system,self.settings.as_ref().is_some_and(|s|s.settings.plugins.system)));
        if let Some(s)=&self.monitor.system.data{
            body=body.child(self.row(self.t("机器","Machine"),format!("{} · {} {}",s.hostname,s.platform,s.os_version))).child(self.row("CPU",format!("{} · {} cores · {}",s.cpu_model,s.cpu_cores,percent(s.cpu_percent))))
                .child(self.row(self.t("运行时长","Uptime"),format!("{:.1} h",s.uptime_seconds/3600.))).child(self.row(self.t("采样时间","Sample time"),s.collected_at.clone()))
                .child(self.trend(self.t("CPU 趋势","CPU history"),s.history.iter().map(|p|p.cpu_percent).collect()))
                .child(self.trend(self.t("内存趋势","Memory history"),s.history.iter().map(|p|Some(p.memory_percent)).collect()))
                .child(self.row(self.t("内存使用 / 总量","Memory used / total"),format!("{} / {}",bytes(s.memory_used),bytes(s.memory_total))))
                .child(self.row(self.t("应用 / 联动 / 压缩","App / Wired / Compressed"),format!("{} / {} / {}",bytes(s.memory_app),bytes(s.memory_wired),bytes(s.memory_compressed))))
                .child(self.row("Swap",bytes(s.swap_used))).child(self.row(self.t("磁盘已用 / 可用 / 总量","Disk used / available / total"),format!("{} / {} / {}",s.disk_used.map(bytes).unwrap_or_else(||"—".into()),s.disk_available.map(bytes).unwrap_or_else(||"—".into()),s.disk_total.map(bytes).unwrap_or_else(||"—".into()))))
                .child(self.row(self.t("默认网卡","Default interface"),s.network_interface.clone().unwrap_or_else(||"—".into()))).child(self.row(self.t("网络接收 / 发送","Network receive / send"),format!("{} / {}",s.rx_bytes_per_second.map(|v|format!("{}/s",bytes(v as u64))).unwrap_or_else(||"—".into()),s.tx_bytes_per_second.map(|v|format!("{}/s",bytes(v as u64))).unwrap_or_else(||"—".into()))))
                .child(self.chips("process-rank",&[("CPU 排行","CPU ranking"),("内存排行","Memory ranking")],cx));
            let processes=if self.filter("process-rank")==0{&s.processes}else{&s.memory_processes};for process in processes{body=body.child(self.row(format!("{} · {}",process.pid,process.name),format!("{} · {}",percent(Some(process.cpu_percent)),bytes(process.memory_bytes))));}
        }body.into_any_element()
    }
    fn trend(&self,title:&str,samples:Vec<Option<f64>>)->AnyElement{
        let p=self.palette();let known=samples.iter().filter(|v|v.is_some()).count();
        let chart=canvas(move|bounds,_,_|bounds,move|bounds,_,window,_|{let width=f32::from(bounds.size.width)/samples.len().max(1) as f32;for(i,value)in samples.iter().enumerate(){if let Some(value)=value{let height=f32::from(bounds.size.height)*(value.clamp(0.,100.)as f32/100.);window.paint_quad(fill(Bounds::new(point(bounds.left()+px(i as f32*width),bounds.bottom()-px(height)),size(px(width.max(1.)),px(height))),rgb(p.accent)));}}}).w_full().h(px(76.));
        self.section(title.to_owned()).child(chart).child(self.note(format!("{known} {} · 0–100%",self.t("有效样本","valid samples")))).into_any_element()
    }
    pub(super) fn marketplace(&self,cx:&mut Context<Self>)->AnyElement{
        let mut body=div().flex().flex_col().gap_3().child(self.search.clone()).child(self.chips("market-filter",&[("全部","All"),("已安装","Installed"),("可更新","Updates")],cx)).child(self.command("marketplace_check",self.t("检查官方目录","Check official catalog"),cx));
        if let Some(market)=&self.market{if let Some(error)=&market.catalog_error{body=body.child(self.note(error.clone()));}if market.checking{body=body.child(self.note(self.t("正在检查目录…","Checking catalog…")));}
            if let Some(op)=&market.operation{body=body.child(self.row(op.id.clone(),format!("{} · {} · {} / {}",self.label(op.action),self.label(op.phase),bytes(op.received_bytes as u64),bytes(op.total_bytes as u64)))).child(self.command("marketplace_cancel",self.t("取消操作","Cancel operation"),cx));}
            if let Some(error)=&market.error{let command=match error.action{oc_core::marketplace::Action::Install=>"marketplace_install",oc_core::marketplace::Action::Update=>"marketplace_update",oc_core::marketplace::Action::Uninstall=>"marketplace_uninstall"};body=body.child(self.note(format!("{}: {}",error.id,error.message))).child(self.button("market-retry",self.t("重试失败操作","Retry failed operation"),Action::Confirm(command,error.id.clone()),market.operation.is_none(),cx));}
            let query=self.search.read(cx).text.to_lowercase();let mut shown=0;for item in &market.items{if self.filter("market-filter")==1&&!item.installed||self.filter("market-filter")==2&&!item.update_available{continue;}if !format!("{} {} {} {}",item.manifest.name,item.manifest.name_en,item.manifest.publisher,item.manifest.permissions.join(" ")).to_lowercase().contains(&query){continue;}shown+=1;
                let name=self.t(&item.manifest.name,&item.manifest.name_en).to_owned();let mut plugin=self.section(name).child(self.note(self.t(&item.manifest.description,&item.manifest.description_en).to_owned())).child(self.row(self.t("发布者 / 版本","Publisher / Version"),format!("{} · {}",item.manifest.publisher,item.manifest.version))).child(self.row(self.t("权限","Permissions"),item.manifest.permissions.iter().map(|permission|{let(zh,en)=labels::permission_labels(permission);self.t(zh,en)}).collect::<Vec<_>>().join(", "))).child(self.row(self.t("安装版本 / 来源","Installed version / Source"),format!("{} · {}",item.installed_version.as_deref().unwrap_or("—"),self.label(item.source))));
                if let Some(error)=&item.error{plugin=plugin.child(self.note(error.clone()));}let mut controls=self.toolbar();if !item.installed{controls=controls.child(self.button(format!("install-{}",item.manifest.id),self.t("安装（支持随附离线包）","Install (bundled packages work offline)"),Action::Confirm("marketplace_install",item.manifest.id.clone()),market.operation.is_none(),cx));}else{if item.update_available{controls=controls.child(self.button(format!("update-{}",item.manifest.id),self.t("更新插件","Update plugin"),Action::Confirm("marketplace_update",item.manifest.id.clone()),market.operation.is_none(),cx));}controls=controls.child(self.button(format!("uninstall-{}",item.manifest.id),self.t("卸载插件","Uninstall plugin"),Action::Confirm("marketplace_uninstall",item.manifest.id.clone()),market.operation.is_none(),cx));}body=body.child(plugin.child(controls));
            }if shown==0{body=body.child(self.note(self.t("没有符合条件的插件；进行中的操作仍显示在上方。","No plugins match. Any active operation remains visible above.")));}
        }else{body=body.child(self.note(self.t("正在读取插件目录…","Loading plugin catalog…")));}body.into_any_element()
    }
    pub(super) fn sources(&self,cx:&mut Context<Self>)->AnyElement{
        let mut body=div().flex().flex_col().gap_3();for section in MonitorSection::ALL{let enabled=self.settings.as_ref().is_some_and(|s|s.settings.plugins.get(section));let mut panel=self.section(self.label(section)).child(self.toolbar().child(self.button(format!("toggle-{}",section.as_str()),if enabled{self.t("停用采集","Disable collection")}else{self.t("启用采集","Enable collection")},Action::Patch(json!({"plugins":{section.as_str():!enabled}})),self.settings.is_some(),cx)).child(self.button(format!("refresh-{}",section.as_str()),self.t("刷新分区","Refresh section"),Action::Command("monitor_refresh",json!({"section":section})),enabled,cx)));
            let sources=match section{MonitorSection::Agents=>self.monitor.agents.data.as_ref().map(|s|&s.sources),MonitorSection::Schedules=>self.monitor.schedules.data.as_ref().map(|s|&s.sources),MonitorSection::System=>self.monitor.system.data.as_ref().map(|s|&s.sources),MonitorSection::Events=>self.monitor.events.data.as_ref().map(|s|&s.sources)};
            if let Some(sources)=sources{for source in sources{let selected=matches!(&self.selection,Some(NavigationTarget::Source{id,section:s})if id==&source.id&&*s==section);let key=format!("source-{}-{}",section.as_str(),source.id);let Some(handle)=self.stable_handle(&key,cx)else{panel=panel.child(self.note("来源控件超过安全预算 / Source control budget exceeded"));break;};let mut row=div().id(SharedString::from(key.clone())).relative().track_focus(&handle).p_3().border_1().border_color(rgb(self.palette().line)).when(selected,|s|s.bg(rgb(self.palette().selected))).child(self.row(source.label.clone(),format!("{} · {}",self.label(source.state),source.id))).child(self.note(source.detail.clone())).child(self.row(self.t("最后尝试 / 成功","Last attempt / success"),format!("{} / {}",source.last_attempt_at.as_deref().unwrap_or("—"),source.last_success_at.as_deref().unwrap_or("—"))));
                if selected{let pending=self.source_jump.clone();let scroll=self.scrolls[AppPage::Sources as usize].clone();let entity=cx.entity().downgrade();let target=self.selection.clone();row=row.child(canvas(move|rect,window,_|{if pending.replace(false){let offset=scroll.offset();window.on_next_frame(move|window,cx|{let _=entity.update(cx,|this,cx|{if this.page==AppPage::Sources&&this.selection==target{scroll.set_offset(point(offset.x,offset.y-(rect.top()-scroll.bounds().top())));handle.focus(window);cx.notify();}});});}},|_,_,_,_|{}).absolute().top_0().left_0().size_full());}
                row=self.mark_bounds(&key,row,cx);
                if let Some(diagnostics)=&source.diagnostics{for diagnostic in diagnostics{row=row.child(self.note(format!("{} · {} · {} · {}",self.label(diagnostic.operation),self.label(diagnostic.stage),self.label(diagnostic.code),diagnostic.observed_at)));}}
                if let Some(resources)=&source.resources{row=row.child(self.resource_budget(resources));}
                if let Some(retry)=source.retry{let action=match retry{SourceRetry::Source=>Action::Command("monitor_retry_source",json!({"sourceId":source.id})),SourceRetry::Section=>Action::Command("monitor_refresh",json!({"section":section}))};row=row.child(self.button(format!("retry-source-{}",source.id),self.t("重试来源","Retry source"),action,enabled,cx));}panel=panel.child(row);
            }}else{panel=panel.child(self.note(self.t("尚无来源快照","No source snapshot yet")));}body=body.child(panel);}
        body=body.child(self.section(self.t("诊断报告","Diagnostic report")).child(self.note(self.t("报告包含来源状态和受限资源统计，不代表进程堆内存或 RSS。","Reports include source state and bounded resource accounting, not process heap or RSS measurements."))).child(self.toolbar().child(self.command("diagnostics_generate",self.t("生成诊断预览","Generate diagnostic preview"),cx)).child(self.command("diagnostics_cancel",self.t("取消 / 清除预览","Cancel / Clear preview"),cx))));
        if let Some(preview)=&self.diagnostic{let report=&preview.content;let font=self.settings.as_ref().map(|s|match s.settings.code_font{CodeFont::System|CodeFont::Menlo=>"Menlo",CodeFont::Monaco=>"Monaco"}).unwrap_or("Menlo");body=body.child(self.row(self.t("报告大小","Report size"),bytes(report.bytes as u64))).child(self.row(self.t("裁剪限制","Trimming limits"),if report.limits.is_empty(){self.t("未裁剪","Not trimmed").to_owned()}else{report.limits.join(", ")}));for(label,count)in [(self.t("来源覆盖","Source coverage"),&report.coverage.sources),(self.t("诊断覆盖","Diagnostic coverage"),&report.coverage.diagnostics),(self.t("资源覆盖","Resource coverage"),&report.coverage.resources)]{body=body.child(self.row(label,format!("{} / {}",count.included,count.total.map(|n|n.to_string()).unwrap_or_else(||self.t("未知","Unknown").into()))));}body=body.child(self.toolbar().child(self.button("diagnostic-copy",self.t("复制 JSON","Copy JSON"),Action::Command("diagnostics_copy",json!({"id":preview.id})),true,cx)).child(self.button("diagnostic-save",self.t("另存 JSON","Save JSON"),Action::Command("diagnostics_save",json!({"id":preview.id})),true,cx))).child(div().max_h(px(280.)).id("diagnostic-preview").overflow_y_scroll().p_3().bg(rgb(self.palette().surface)).font_family(font).text_sm().child(report.json.clone()));}
        body.into_any_element()
    }
}

fn agent_status_source(agent:&AgentInfo)->Option<&'static str>{
    if agent.runtime=="OMP"&&agent.kind==AgentKind::Subagent&&agent.state==AgentState::Unknown{Some("omp-ownership")}
    else if agent.runtime=="Codex"&&agent.state==AgentState::Unknown&&agent.session_id.as_ref().is_some_and(|id|!id.is_empty()){Some("codex-sessions")}
    else if agent.state==AgentState::Running{Some("processes")}
    else if agent.runtime=="OMP"&&agent.kind==AgentKind::Main&&matches!(agent.state,AgentState::Working|AgentState::Idle)&&agent.source=="Tern pane working state + OMP ownership/session descriptors"{Some("tern-state")}
    else{None}
}

fn job_has_source(job:&ScheduledJob,source_id:&str)->bool{
    let metadata_only=job.source=="OMP 任务 · 未发现 launchd 配置";
    let omp=metadata_only||job.source=="launchd · OMP 任务";
    if source_id=="hermes-runtime"&&job.id.starts_with("hermes-job:"){return true;}
    if source_id=="crontab"&&job.id.starts_with("crontab:"){return true;}
    if source_id=="omp-cron"&&omp{return true;}
    if !job.id.starts_with("launchd:")||metadata_only{return false;}
    match job.scope{
        JobScope::System=>source_id=="launchctl:system",
        JobScope::User=>source_id.strip_prefix("launchctl:gui/").or_else(||source_id.strip_prefix("launchctl:user/")).is_some_and(|uid|!uid.is_empty()&&uid.bytes().all(|byte|byte.is_ascii_digit())),
    }
}

#[cfg(test)]
mod source_link_tests{
    use super::*;
    use core::prelude::v1::test;
    #[test]
    fn schedules_link_only_matching_collected_source_ids(){
        let mut job:ScheduledJob=serde_json::from_value(json!({"id":"hermes-job:example","name":"Example","source":"Hermes 任务（由调度器执行）","scope":"user","origin":"personal","kind":"interval","schedule":"hourly","state":"unknown"})).unwrap();
        let sources=[SourceStatus::new("hermes-runtime","Hermes",SourceState::Ok,""),SourceStatus::new("launchctl:gui/501","GUI",SourceState::Ok,""),SourceStatus::new("launchctl:user/501","User",SourceState::Ok,""),SourceStatus::new("launchctl:system","System",SourceState::Ok,""),SourceStatus::new("omp-cron","OMP",SourceState::Ok,"")];
        let ids=|job:&ScheduledJob|sources.iter().filter(|source|job_has_source(job,&source.id)).map(|source|source.id.as_str()).collect::<Vec<_>>();
        assert_eq!(ids(&job),vec!["hermes-runtime"]);
        assert!(!job_has_source(&job,&job.source));
        job.id="launchd:example".into();job.source="launchd · OMP 任务".into();
        assert_eq!(ids(&job),vec!["launchctl:gui/501","launchctl:user/501","omp-cron"]);
        assert!(!job_has_source(&job,"launchctl:gui/"));assert!(!job_has_source(&job,"launchctl:gui/abc"));
        job.scope=JobScope::System;assert_eq!(ids(&job),vec!["launchctl:system","omp-cron"]);
        job.source="OMP 任务 · 未发现 launchd 配置".into();assert_eq!(ids(&job),vec!["omp-cron"]);
        job.id="crontab:example".into();job.source="crontab · 当前用户".into();
        assert!(job_has_source(&job,"crontab"));assert!(ids(&job).is_empty());
        job.id="unrecognized".into();assert!(ids(&job).is_empty());
    }
    #[test]
    fn agents_require_exact_state_evidence_and_present_sources(){
        let mut agent:AgentInfo=serde_json::from_value(json!({"id":"agent","name":"Agent","runtime":"OMP","kind":"subagent","state":"unknown","pid":42,"source":"description"})).unwrap();
        assert_eq!(agent_status_source(&agent),Some("omp-ownership"));
        agent.runtime="Codex".into();assert_eq!(agent_status_source(&agent),None);
        agent.session_id=Some("session".into());assert_eq!(agent_status_source(&agent),Some("codex-sessions"));
        agent.state=AgentState::Running;assert_eq!(agent_status_source(&agent),Some("processes"));
        agent.runtime="OMP".into();agent.kind=AgentKind::Main;agent.state=AgentState::Idle;
        assert_eq!(agent_status_source(&agent),None);
        agent.source="Tern pane working state + OMP ownership/session descriptors".into();assert_eq!(agent_status_source(&agent),Some("tern-state"));
        let sources=[SourceStatus::new("processes","Processes",SourceState::Ok,"")];
        assert!(sources.iter().find(|source|agent_status_source(&agent)==Some(source.id.as_str())).is_none());
        agent.state=AgentState::Unknown;assert_eq!(agent_status_source(&agent),None);
    }
}
