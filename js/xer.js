/* =============================================================================
   xer.js — export the current plan as a Primavera P6 XER file, matching the
   shape the taskmapper system ingests (see [Sample] sheet-piling plan).

   The XER is tab-delimited: an ERMHDR line, then repeating table blocks
     %T <table>  /  %F <col>\t<col>…  /  %R <val>\t<val>…  , terminated by %E.

   We reproduce the sample's TABLE/FIELD layout, UDF definitions, units and P6
   config tokens exactly (that's the format contract), and fill the PROJECT /
   WBS / TASK / TASKPRED / TASKRSRC / UDFVALUE content from OUR plan:
     • one TASK per chainage scheduled in the 2/3-week window;
     • WBS grouped by profile (Item Description);
     • one RT_Equip resource per deployed machine + one RT_Labor crew, assigned
       to each task with target_qty = piles (this window);
     • FS links chaining each machine's chainages in worked order;
     • UDFs: Quantity Nos, Pile Type, Length Km, Area SqMtr, Notes.
   ============================================================================= */
(function () {
  "use strict";
  const SPP = window.SPP;
  const U = SPP.util;
  const X = (SPP.xer = {});

  // Top-level WBS (project root) name. Edit here to change the export title.
  const PROJECT_TITLE = "Kutch RE Z2 - Sheet Pile";

  // Exact field order per table (from the sample; do not reorder).
  const F = {
    CURRTYPE: ["curr_id", "decimal_digit_cnt", "curr_symbol", "decimal_symbol", "digit_group_symbol", "pos_curr_fmt_type", "neg_curr_fmt_type", "curr_type", "curr_short_name", "group_digit_cnt", "base_exch_rate"],
    FINTMPL: ["fintmpl_id", "fintmpl_name", "default_flag"],
    OBS: ["obs_id", "parent_obs_id", "guid", "seq_num", "obs_name", "obs_descr"],
    UDFTYPE: ["udf_type_id", "table_name", "udf_type_name", "udf_type_label", "logical_data_type", "super_flag", "indicator_expression", "summary_indicator_expression", "export_flag"],
    UMEASURE: ["unit_id", "seq_num", "unit_abbrev", "unit_name"],
    PROJECT: ["proj_id", "fy_start_month_num", "rsrc_self_add_flag", "allow_complete_flag", "rsrc_multi_assign_flag", "checkout_flag", "project_flag", "step_complete_flag", "cost_qty_recalc_flag", "batch_sum_flag", "name_sep_char", "def_complete_pct_type", "proj_short_name", "acct_id", "orig_proj_id", "source_proj_id", "base_type_id", "clndr_id", "sum_base_proj_id", "task_code_base", "task_code_step", "priority_num", "wbs_max_sum_level", "strgy_priority_num", "last_checksum", "critical_drtn_hr_cnt", "def_cost_per_qty", "last_recalc_date", "plan_start_date", "plan_end_date", "scd_end_date", "add_date", "last_tasksum_date", "fcst_start_date", "def_duration_type", "task_code_prefix", "guid", "def_qty_type", "add_by_name", "web_local_root_path", "proj_url", "def_rate_type", "add_act_remain_flag", "act_this_per_link_flag", "def_task_type", "act_pct_link_flag", "critical_path_type", "task_code_prefix_flag", "def_rollup_dates_flag", "use_project_baseline_flag", "rem_target_link_flag", "reset_planned_flag", "allow_neg_act_flag", "sum_assign_level", "last_fin_dates_id", "fintmpl_id", "last_baseline_update_date", "cr_external_key", "apply_actuals_date", "location_id", "loaded_scope_level", "export_flag", "new_fin_dates_id", "baselines_to_export", "baseline_names_to_export", "next_data_date", "close_period_flag", "sum_refresh_date", "trsrcsum_loaded", "sumtask_loaded"],
    CALENDAR: ["clndr_id", "default_flag", "clndr_name", "proj_id", "base_clndr_id", "last_chng_date", "clndr_type", "day_hr_cnt", "week_hr_cnt", "month_hr_cnt", "year_hr_cnt", "rsrc_private", "clndr_data"],
    SCHEDOPTIONS: ["schedoptions_id", "proj_id", "sched_outer_depend_type", "sched_open_critical_flag", "sched_lag_early_start_flag", "sched_retained_logic", "sched_setplantoforecast", "sched_float_type", "sched_calendar_on_relationship_lag", "sched_use_expect_end_flag", "sched_progress_override", "level_float_thrs_cnt", "level_outer_assign_flag", "level_outer_assign_priority", "level_over_alloc_pct", "level_within_float_flag", "level_keep_sched_date_flag", "level_all_rsrc_flag", "sched_use_project_end_date_for_float", "enable_multiple_longest_path_calc", "limit_multiple_longest_path_calc", "max_multiple_longest_path", "use_total_float_multiple_longest_paths", "key_activity_for_multiple_longest_paths", "LevelPriorityList"],
    PROJWBS: ["wbs_id", "proj_id", "obs_id", "seq_num", "est_wt", "proj_node_flag", "sum_data_flag", "status_code", "wbs_short_name", "wbs_name", "phase_id", "parent_wbs_id", "ev_user_pct", "ev_etc_user_value", "orig_cost", "indep_remain_total_cost", "ann_dscnt_rate_pct", "dscnt_period_type", "indep_remain_work_qty", "anticip_start_date", "anticip_end_date", "ev_compute_type", "ev_etc_compute_type", "guid", "tmpl_guid", "plan_open_state"],
    RSRC: ["rsrc_id", "parent_rsrc_id", "clndr_id", "role_id", "shift_id", "user_id", "pobs_id", "guid", "rsrc_seq_num", "email_addr", "employee_code", "office_phone", "other_phone", "rsrc_name", "rsrc_short_name", "rsrc_title_name", "def_qty_per_hr", "cost_qty_type", "ot_factor", "active_flag", "auto_compute_act_flag", "def_cost_qty_link_flag", "ot_flag", "curr_id", "unit_id", "rsrc_type", "location_id", "rsrc_notes", "load_tasks_flag", "level_flag", "last_checksum"],
    RSRCRATE: ["rsrc_rate_id", "rsrc_id", "max_qty_per_hr", "cost_per_qty", "start_date", "shift_period_id", "cost_per_qty2", "cost_per_qty3", "cost_per_qty4", "cost_per_qty5"],
    TASK: ["task_id", "proj_id", "wbs_id", "clndr_id", "phys_complete_pct", "rev_fdbk_flag", "est_wt", "lock_plan_flag", "auto_compute_act_flag", "complete_pct_type", "task_type", "duration_type", "status_code", "task_code", "task_name", "rsrc_id", "total_float_hr_cnt", "free_float_hr_cnt", "remain_drtn_hr_cnt", "act_work_qty", "remain_work_qty", "target_work_qty", "target_drtn_hr_cnt", "target_equip_qty", "act_equip_qty", "remain_equip_qty", "cstr_date", "act_start_date", "act_end_date", "late_start_date", "late_end_date", "expect_end_date", "early_start_date", "early_end_date", "restart_date", "reend_date", "target_start_date", "target_end_date", "rem_late_start_date", "rem_late_end_date", "cstr_type", "priority_type", "suspend_date", "resume_date", "float_path", "float_path_order", "guid", "tmpl_guid", "cstr_date2", "cstr_type2", "driving_path_flag", "act_this_per_work_qty", "act_this_per_equip_qty", "external_early_start_date", "external_late_end_date", "create_date", "update_date", "create_user", "update_user", "location_id", "crt_path_num"],
    TASKPRED: ["task_pred_id", "task_id", "pred_task_id", "proj_id", "pred_proj_id", "pred_type", "lag_hr_cnt", "comments", "float_path", "aref", "arls"],
    TASKRSRC: ["taskrsrc_id", "task_id", "proj_id", "cost_qty_link_flag", "role_id", "acct_id", "rsrc_id", "pobs_id", "skill_level", "remain_qty", "target_qty", "remain_qty_per_hr", "target_lag_drtn_hr_cnt", "target_qty_per_hr", "act_ot_qty", "act_reg_qty", "relag_drtn_hr_cnt", "ot_factor", "cost_per_qty", "target_cost", "act_reg_cost", "act_ot_cost", "remain_cost", "act_start_date", "act_end_date", "restart_date", "reend_date", "target_start_date", "target_end_date", "rem_late_start_date", "rem_late_end_date", "rollup_dates_flag", "target_crv", "remain_crv", "actual_crv", "ts_pend_act_end_flag", "guid", "rate_type", "act_this_per_cost", "act_this_per_qty", "curv_id", "rsrc_type", "cost_per_qty_source_type", "create_user", "create_date", "has_rsrchours", "taskrsrc_sum_id"],
    UDFVALUE: ["udf_type_id", "fk_id", "proj_id", "udf_date", "udf_number", "udf_text", "udf_code_id"]
  };

  // Fields that P6 stores as numbers (from the sample). A parser will do
  // float()/int() on these, so an empty string breaks it — default them to 0.
  // NOTE: parent_wbs_id is deliberately EXCLUDED — it must stay empty on the
  // project root node (defaulting it to 0 would orphan the WBS tree).
  const NUM = {
    CURRTYPE: ["curr_id", "decimal_digit_cnt", "group_digit_cnt", "base_exch_rate"],
    FINTMPL: ["fintmpl_id"],
    OBS: ["obs_id", "seq_num"],
    UDFTYPE: ["udf_type_id"],
    UMEASURE: ["unit_id", "seq_num"],
    PROJECT: ["proj_id", "fy_start_month_num", "clndr_id", "task_code_base", "task_code_step", "priority_num", "wbs_max_sum_level", "strgy_priority_num", "critical_drtn_hr_cnt", "def_cost_per_qty", "fintmpl_id", "loaded_scope_level"],
    CALENDAR: ["clndr_id", "day_hr_cnt", "week_hr_cnt", "month_hr_cnt", "year_hr_cnt"],
    SCHEDOPTIONS: ["schedoptions_id", "proj_id", "level_float_thrs_cnt", "level_outer_assign_priority", "level_over_alloc_pct", "max_multiple_longest_path"],
    PROJWBS: ["wbs_id", "proj_id", "obs_id", "seq_num", "est_wt", "ev_user_pct", "ev_etc_user_value", "orig_cost", "indep_remain_total_cost", "ann_dscnt_rate_pct", "indep_remain_work_qty"],
    RSRC: ["rsrc_id", "clndr_id", "rsrc_seq_num", "def_qty_per_hr", "curr_id"],
    TASK: ["task_id", "proj_id", "wbs_id", "clndr_id", "phys_complete_pct", "est_wt", "total_float_hr_cnt", "free_float_hr_cnt", "remain_drtn_hr_cnt", "act_work_qty", "remain_work_qty", "target_work_qty", "target_drtn_hr_cnt", "target_equip_qty", "act_equip_qty", "remain_equip_qty", "act_this_per_work_qty", "act_this_per_equip_qty"],
    TASKPRED: ["task_pred_id", "task_id", "pred_task_id", "proj_id", "pred_proj_id", "lag_hr_cnt"],
    TASKRSRC: ["taskrsrc_id", "task_id", "proj_id", "rsrc_id", "remain_qty", "target_qty", "remain_qty_per_hr", "target_lag_drtn_hr_cnt", "target_qty_per_hr", "act_ot_qty", "act_reg_qty", "relag_drtn_hr_cnt", "ot_factor", "cost_per_qty", "target_cost", "act_reg_cost", "act_ot_cost", "remain_cost", "act_this_per_cost", "act_this_per_qty"],
    UDFVALUE: ["udf_type_id", "fk_id", "proj_id"]
  };

  // XER is CRLF-terminated, ASCII, no BOM (matches the taskmapper sample).
  const EOL = "\r\n";
  // Sanitize a field value for the tab-delimited .xer (strip tabs/newlines).
  function clean(v) {
    if (v == null) return "";
    return String(v)
      .replace(/[\t\r\n]+/g, " ")        // never break the TSV rows
      .replace(/[^\x20-\x7E]/g, "");     // keep it plain ASCII
  }
  // Emit a %T/%F/%R table block for a record set.
  function emit(name, rows) {
    const fields = F[name];
    const numset = new Set(NUM[name] || []);
    let s = "%T\t" + name + EOL + "%F\t" + fields.join("\t") + EOL;
    rows.forEach((r) => {
      s += "%R\t" + fields.map((f) => {
        let v = r[f];
        if ((v == null || v === "") && numset.has(f)) v = 0;   // numeric fields never empty
        return clean(v);
      }).join("\t") + EOL;
    });
    return s;
  }

  // Zero-pad a number to two digits (for date fields).
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  // "2026-07-13 08:00"
  function dt(d, hhmm) { return d ? U.fmtISO(d) + " " + (hhmm || "08:00") : ""; }
  // Round to 4 decimals for numeric .xer fields.
  function n4(x) { return Math.round((x || 0) * 10000) / 10000; }
  // Generate a P6-style GUID for records that need one.
  function guid() {
    const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let s = ""; for (let i = 0; i < 22; i++) s += c[Math.floor(Math.random() * c.length)];
    return s;
  }
  // working days in [a,b] inclusive for an N-day work-week (isoDow 1=Mon..7=Sun)
  function workingDaysBetween(a, b, wd) {
    if (!a || !b) return 1;
    let n = 0, d = new Date(a), guard = 0;
    while (U.cmpDate(d, b) <= 0 && guard < 4000) { if (U.isoDow(d) <= wd) n++; d = U.addDays(d, 1); guard++; }
    return n || 1;
  }
  // P6 clndr_data for an N-day week / H-hour day. P6 DaysOfWeek: 1=Sun..7=Sat.
  function calData(wd, wh) {
    const fin = pad2(Math.min(23, 8 + wh)) + ":00";
    let days = "";
    for (let pday = 1; pday <= 7; pday++) {
      const isoDow = pday === 1 ? 7 : pday - 1;         // map P6 day -> isoDow (Mon=1..Sun=7)
      const working = isoDow <= wd;
      days += working
        ? "(0||" + pday + "()(      (0||0(s|08:00|f|" + fin + ")())))"
        : "(0||" + pday + "()())";
    }
    return "(0||CalendarData()(  (0||DaysOfWeek()(    " + days + "))  (0||VIEW(ShowTotal|Y)())  (0||Exceptions()())))";
  }

  X.build = function (r, store) {
    const p = r.params;
    const wd = p.workDaysPerWeek, wh = p.workhours;
    const finHour = pad2(Math.min(23, 8 + wh)) + ":00";
    const PROJ = 4001, OBSID = 1001, CLNDR = 7001, FINT = 1, ROOT_WBS = 5001;
    const nowDT = dt(new Date());
    const projShort = ("SHP-" + (p.priority || "PLAN")).replace(/[^A-Za-z0-9_\-]/g, "");
    const featById = {}; (store.chainage.features || []).forEach((f) => { featById[f.id] = f; });

    // Chainages scheduled in the window, ordered by machine then start (stable codes).
    const worked = (r.worked || []).slice().sort((a, b) =>
      a.machine - b.machine || a.startDate - b.startDate || U.chainageSortKey(a.id) - U.chainageSortKey(b.id));

    let out = ["ERMHDR", "21.12", U.fmtISO(new Date()), "Project", "admin", "admin", "dbxDatabaseNoName", "Project Management", "INR"].join("\t") + EOL;

    out += emit("CURRTYPE", [{ curr_id: 1, decimal_digit_cnt: 2, curr_symbol: "Rs", decimal_symbol: ".", digit_group_symbol: ",", pos_curr_fmt_type: "#1.1", neg_curr_fmt_type: "(#1.1)", curr_type: "Indian Rupees", curr_short_name: "INR", group_digit_cnt: 3, base_exch_rate: 1 }]);
    out += emit("FINTMPL", [{ fintmpl_id: FINT, fintmpl_name: "Calendar", default_flag: "Y" }]);
    out += emit("OBS", [{ obs_id: OBSID, seq_num: 0, obs_name: "Enterprise" }]);
    out += emit("UDFTYPE", [
      { udf_type_id: 901, table_name: "TASK", udf_type_name: "user_field_901", udf_type_label: "Quantity Nos", logical_data_type: "FT_TEXT", super_flag: "N" },
      { udf_type_id: 902, table_name: "TASK", udf_type_name: "user_field_902", udf_type_label: "Pile Type", logical_data_type: "FT_TEXT", super_flag: "N" },
      { udf_type_id: 903, table_name: "TASK", udf_type_name: "user_field_903", udf_type_label: "Length Km", logical_data_type: "FT_TEXT", super_flag: "N" },
      { udf_type_id: 904, table_name: "TASK", udf_type_name: "user_field_904", udf_type_label: "Area SqMtr", logical_data_type: "FT_TEXT", super_flag: "N" },
      { udf_type_id: 905, table_name: "TASK", udf_type_name: "user_field_905", udf_type_label: "Notes", logical_data_type: "FT_TEXT", super_flag: "N" }
    ]);
    out += emit("UMEASURE", [
      { unit_id: 1, seq_num: 1, unit_abbrev: "Nos", unit_name: "Numbers" },
      { unit_id: 2, seq_num: 2, unit_abbrev: "EA", unit_name: "Each" },
      { unit_id: 3, seq_num: 3, unit_abbrev: "M", unit_name: "Meter" },
      { unit_id: 4, seq_num: 4, unit_abbrev: "KM", unit_name: "Kilometer" },
      { unit_id: 5, seq_num: 5, unit_abbrev: "SQM", unit_name: "Square Meter" }
    ]);

    out += emit("PROJECT", [{
      proj_id: PROJ, fy_start_month_num: 1, rsrc_self_add_flag: "Y", allow_complete_flag: "Y",
      rsrc_multi_assign_flag: "Y", checkout_flag: "N", project_flag: "Y", step_complete_flag: "N",
      cost_qty_recalc_flag: "N", batch_sum_flag: "N", name_sep_char: ".", def_complete_pct_type: "CP_Drtn",
      proj_short_name: projShort, clndr_id: CLNDR, task_code_base: 1000, task_code_step: 10,
      priority_num: 10, wbs_max_sum_level: 2, strgy_priority_num: 100, def_cost_per_qty: 0,
      last_recalc_date: dt(p.planStart, "00:00"), plan_start_date: dt(p.planStart, "00:00"),
      scd_end_date: dt(r.planEnd, finHour), add_date: dt(new Date(), "00:00"),
      def_duration_type: "DT_FixedDUR2", guid: guid(), def_qty_type: "QT_Item", add_by_name: "admin",
      def_rate_type: "COST_PER_QTY", add_act_remain_flag: "N", act_this_per_link_flag: "N",
      def_task_type: "TT_Task", act_pct_link_flag: "N", critical_path_type: "CT_TotFloat",
      task_code_prefix_flag: "N", def_rollup_dates_flag: "Y", use_project_baseline_flag: "N",
      rem_target_link_flag: "Y", reset_planned_flag: "Y", allow_neg_act_flag: "N",
      sum_assign_level: "SL_Taskrsrc", fintmpl_id: FINT, next_data_date: dt(p.planStart),
      close_period_flag: "N", trsrcsum_loaded: "N", sumtask_loaded: "N", export_flag: "Y"
    }]);

    out += emit("CALENDAR", [{
      clndr_id: CLNDR, default_flag: "Y", clndr_name: projShort + " " + wd + "-Day " + wh + "h Workweek",
      proj_id: PROJ, clndr_type: "CA_Base", day_hr_cnt: wh, week_hr_cnt: wh * wd,
      month_hr_cnt: Math.round(wh * wd * 4.333), year_hr_cnt: wh * wd * 52, rsrc_private: 0,
      clndr_data: calData(wd, wh)
    }]);

    out += emit("SCHEDOPTIONS", [{
      schedoptions_id: 1, proj_id: PROJ, sched_outer_depend_type: "SD_Both", sched_open_critical_flag: "N",
      sched_lag_early_start_flag: "Y", sched_retained_logic: "Y", sched_setplantoforecast: "N",
      sched_float_type: "FT_FF", sched_calendar_on_relationship_lag: "rcal_Predecessor",
      sched_use_expect_end_flag: "Y", sched_progress_override: "N", level_float_thrs_cnt: 0,
      level_outer_assign_flag: "N", level_outer_assign_priority: 5, level_over_alloc_pct: 25,
      level_within_float_flag: "N", level_keep_sched_date_flag: "Y", level_all_rsrc_flag: "Y",
      sched_use_project_end_date_for_float: "Y", enable_multiple_longest_path_calc: "N",
      limit_multiple_longest_path_calc: "Y", max_multiple_longest_path: 10,
      use_total_float_multiple_longest_paths: "Y", LevelPriorityList: "priority_type,ASC_BY_FIELD/ASC"
    }]);

    // ---- WBS hierarchy: Root -> Priority -> Zone -> Profile (tasks hang off Profile).
    const zoneOf = (w) => ((featById[w.id] || {}).zone) || "(zone n/a)";
    let wid = ROOT_WBS;
    // Add a WBS node row (Root -> Priority -> Zone -> Profile hierarchy).
    function wbsNode(id, parent, seq, code, name, isRoot) {
      return {
        wbs_id: id, proj_id: PROJ, obs_id: OBSID, seq_num: seq, est_wt: 1,
        proj_node_flag: isRoot ? "Y" : "N", sum_data_flag: "Y", status_code: "WS_Open",
        wbs_short_name: code, wbs_name: name, parent_wbs_id: isRoot ? "" : parent,
        ev_compute_type: "EC_Cmp_pct", ev_etc_compute_type: "EE_Etc_pct", guid: guid()
      };
    }
    const wbsRows = [];
    // L1 project root
    const rootId = wid++;
    wbsRows.push(wbsNode(rootId, "", 0, projShort, PROJECT_TITLE, true));
    // L2 priority (single)
    const priId = wid++;
    wbsRows.push(wbsNode(priId, rootId, 1, "1", (p.priority || "Priority"), false));
    // Build unique zones (sorted) and their profiles (sorted) from worked chainages.
    const zoneProfiles = {};   // zone -> [profiles...]
    worked.forEach((w) => {
      const z = zoneOf(w);
      (zoneProfiles[z] || (zoneProfiles[z] = []));
      if (zoneProfiles[z].indexOf(w.profile) < 0) zoneProfiles[z].push(w.profile);
    });
    const wbsIdByZoneProfile = {};   // "zone||profile" -> wbs_id
    Object.keys(zoneProfiles).sort().forEach((zone, zi) => {
      const zoneWid = wid++;
      wbsRows.push(wbsNode(zoneWid, priId, zi + 1, String(zi + 1), zone, false));   // L3 zone
      zoneProfiles[zone].sort().forEach((prof, pi) => {
        const profWid = wid++;
        wbsRows.push(wbsNode(profWid, zoneWid, pi + 1, String(pi + 1), prof, false)); // L4 profile
        wbsIdByZoneProfile[zone + "||" + prof] = profWid;
      });
    });
    out += emit("PROJWBS", wbsRows);

    // ---- Resources: one equipment per deployed machine + one labour crew ----
    const rsrcRows = [], machRsrc = {};
    let rid = 6001;
    for (let m = 1; m <= r.deployed; m++) {
      machRsrc[m] = rid;
      rsrcRows.push({
        rsrc_id: rid, clndr_id: CLNDR, guid: guid(), rsrc_seq_num: m, rsrc_name: "Machine " + m,
        rsrc_short_name: "M" + m, def_qty_per_hr: 1, cost_qty_type: "QT_Hour", ot_factor: 0,
        active_flag: "Y", auto_compute_act_flag: "N", def_cost_qty_link_flag: "Y", ot_flag: "N",
        curr_id: 1, unit_id: 1, rsrc_type: "RT_Equip", load_tasks_flag: "N", level_flag: "Y"
      });
      rid++;
    }
    const CREW = 6900;
    rsrcRows.push({
      rsrc_id: CREW, clndr_id: CLNDR, guid: guid(), rsrc_seq_num: 99, rsrc_name: "Piling Crew",
      rsrc_short_name: "CREW", def_qty_per_hr: 1, cost_qty_type: "QT_Hour", ot_factor: 0,
      active_flag: "Y", auto_compute_act_flag: "N", def_cost_qty_link_flag: "Y", ot_flag: "N",
      curr_id: 1, unit_id: 1, rsrc_type: "RT_Labor", load_tasks_flag: "N", level_flag: "Y"
    });
    out += emit("RSRC", rsrcRows);
    out += emit("RSRCRATE", []);

    // ---- Tasks: one per worked chainage ----
    const taskRows = [], taskIdById = {};
    let tid = 8001, tcode = 1000;
    worked.forEach((w) => {
      const durHr = workingDaysBetween(w.startDate, w.lastDate, wd) * wh;
      taskIdById[w.id] = tid;
      taskRows.push({
        task_id: tid, proj_id: PROJ, wbs_id: wbsIdByZoneProfile[zoneOf(w) + "||" + w.profile], clndr_id: CLNDR,
        phys_complete_pct: 0, rev_fdbk_flag: "N", est_wt: 1, lock_plan_flag: "N", auto_compute_act_flag: "Y",
        complete_pct_type: "CP_Drtn", task_type: "TT_Task", duration_type: "DT_FixedDUR2",
        status_code: "TK_NotStart", task_code: String(tcode), task_name: w.id + " - " + w.profile,
        rsrc_id: machRsrc[w.machine] || "", total_float_hr_cnt: 0, free_float_hr_cnt: 0,
        remain_drtn_hr_cnt: durHr, act_work_qty: 0, remain_work_qty: 0, target_work_qty: 0,
        target_drtn_hr_cnt: durHr, target_equip_qty: 0, act_equip_qty: 0, remain_equip_qty: 0,
        // Forward baseline: all scheduling dates equal the planned start/finish.
        late_start_date: dt(w.startDate, "08:00"), late_end_date: dt(w.lastDate, finHour),
        early_start_date: dt(w.startDate, "08:00"), early_end_date: dt(w.lastDate, finHour),
        restart_date: dt(w.startDate, "08:00"), reend_date: dt(w.lastDate, finHour),
        target_start_date: dt(w.startDate, "08:00"), target_end_date: dt(w.lastDate, finHour),
        rem_late_start_date: dt(w.startDate, "08:00"), rem_late_end_date: dt(w.lastDate, finHour),
        priority_type: "PT_Normal", guid: guid(), driving_path_flag: "N",
        create_date: nowDT, update_date: nowDT, create_user: "admin", update_user: "admin"
      });
      tid++; tcode += 10;
    });
    out += emit("TASK", taskRows);

    // ---- Predecessors: FS chain along each machine's worked order ----
    const predRows = []; let pid = 9001;
    const byMachine = {};
    worked.forEach((w) => { (byMachine[w.machine] || (byMachine[w.machine] = [])).push(w); });
    Object.keys(byMachine).forEach((m) => {
      const list = byMachine[m];  // already globally sorted by machine,start
      for (let i = 1; i < list.length; i++) {
        predRows.push({
          task_pred_id: pid++, task_id: taskIdById[list[i].id], pred_task_id: taskIdById[list[i - 1].id],
          proj_id: PROJ, pred_proj_id: PROJ, pred_type: "PR_FS", lag_hr_cnt: 0
        });
      }
    });
    out += emit("TASKPRED", predRows);

    // ---- Resource assignments: machine (equip) + crew (labour) per task ----
    const trRows = []; let trid = 10001;
    worked.forEach((w) => {
      const qty = Math.round(w.thisPlan || 0);
      const durHr = workingDaysBetween(w.startDate, w.lastDate, wd) * wh;
      const perHr = durHr > 0 ? n4(qty / durHr) : 0;
      const common = {
        proj_id: PROJ, cost_qty_link_flag: "Y", skill_level: 1, remain_qty: qty, target_qty: qty,
        remain_qty_per_hr: perHr, target_lag_drtn_hr_cnt: 0, target_qty_per_hr: perHr, act_ot_qty: 0,
        act_reg_qty: 0, relag_drtn_hr_cnt: 0, ot_factor: 0, cost_per_qty: 0, target_cost: 0,
        act_reg_cost: 0, act_ot_cost: 0, remain_cost: 0, rollup_dates_flag: "Y",
        target_start_date: dt(w.startDate, "08:00"), target_end_date: dt(w.lastDate, finHour),
        ts_pend_act_end_flag: "N", guid: guid(), rate_type: "COST_PER_QTY",
        cost_per_qty_source_type: "ST_Resource", create_user: "admin", create_date: nowDT, has_rsrchours: "N"
      };
      trRows.push(Object.assign({ taskrsrc_id: trid++, task_id: taskIdById[w.id], rsrc_id: machRsrc[w.machine] || "", rsrc_type: "RT_Equip" }, common));
      trRows.push(Object.assign({ taskrsrc_id: trid++, task_id: taskIdById[w.id], rsrc_id: CREW, rsrc_type: "RT_Labor" }, common, { guid: guid() }));
    });
    out += emit("TASKRSRC", trRows);

    // ---- UDF values per task ----
    const udfRows = [];
    worked.forEach((w) => {
      const f = featById[w.id] || {};
      const fk = taskIdById[w.id];
      // Add a UDF value row for the current task (skips blank/empty values).
      function u(id, txt) { if (txt !== "" && txt != null) udfRows.push({ udf_type_id: id, fk_id: fk, proj_id: PROJ, udf_text: String(txt) }); }
      u(901, Math.round(w.thisPlan || 0));                                   // Quantity Nos (piles this window)
      u(902, w.profile);                                                     // Pile Type
      u(903, f.lengthMm ? (f.lengthMm / 1e6).toFixed(3) : "");               // Length Km (mm -> km)
      u(904, f.areaSqm ? String(Math.round(f.areaSqm)) : "");                // Area SqMtr
      u(905, "Item " + (w.code || "-") + " | Machine " + w.machine + " | " + Math.round(w.thisPlan || 0) + " of " + U.fmtInt(w.mto) + " piles");
    });
    out += emit("UDFVALUE", udfRows);

    out += "%E" + EOL;
    return out;
  };
})();
