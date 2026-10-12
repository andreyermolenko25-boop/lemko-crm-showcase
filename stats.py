"""
Формулы виджетов дашборда и отчётов. Считаются на сервере по записям любого
объекта (records.list_records), с семантикой полей из схемы воркспейса.

Определения
-----------
* Дата записи — поле dateField объекта (у сделки — дата закрытия), иначе createdAt.
* Месяц периода — выбранный в шапке год/месяц; ряды строятся по N месяцам,
  заканчивающимся им (часовой пояс компании).
* Выиграна — стадия в CLOSED_WON (won, completed, paid, done, solved, sold),
  проиграна — CLOSED_LOST (lost, cancelled, churned); открыта — ни то ни другое.
* KPI: sum / avg — по полю суммы (или выбранному), count — число записей,
  conversion = выиграно / (выиграно + проиграно) × 100 по закрытым записям.
  Значение — по всем записям выборки (текущее состояние). Ряд — помесячные
  значения за 9 месяцев; Δ = (тек. месяц − пред.) / |пред.| × 100, для
  conversion — разница в процентных пунктах. Нет прошлого месяца — Δ нет.
* Тренд: накопленная сумма поля (или число записей) по месяцам без проигранных.
  Линия сравнения — план (цель × доля прошедших месяцев), если цель задана,
  иначе накопленный итог того же числа месяцев перед периодом.
* Воронка: запись на стадии i прошла все стадии до неё (проигранные не входят);
  конверсия = последняя / первая × 100; медиана цикла — медиана дней от
  создания до закрытия у выигранных записей.
* Лидерборд: по ответственным — всего записей, выиграно, сумма выигранных.
* Цель: сумма выигранных за квартал / месяц / год периода (или всё время) к цели.
* Отчёт: группировка по полю, мера count / sum / avg.
"""

from __future__ import annotations

import statistics
from collections import defaultdict
from datetime import date, datetime, timezone
from typing import Any, Callable
from zoneinfo import ZoneInfo

import records
import workspace
from core.errors import DomainError

KPI_MONTHS = 9


class StatsError(DomainError):
    status_code = 422


# --------------------------------------------------------------------------- #
#  Общие помощники
# --------------------------------------------------------------------------- #

class Period:
    """Месяц, выбранный в шапке; ключ месяца = год × 12 + (месяц − 1)."""

    def __init__(self, year: int, month: int, tz: ZoneInfo) -> None:
        self.year, self.month, self.tz = year, month, tz
        self.key = year * 12 + (month - 1)

    @staticmethod
    def label(key: int) -> str:
        return f"{key // 12:04d}-{key % 12 + 1:02d}"

    def keys(self, count: int, *, offset: int = 0) -> list[int]:
        end = self.key - offset
        return [end - (count - 1 - i) for i in range(count)]

    def month_key(self, moment: datetime | None) -> int | None:
        if moment is None:
            return None
        local = moment.astimezone(self.tz)
        return local.year * 12 + (local.month - 1)

    def range_keys(self, span: str) -> set[int] | None:
        if span == "all":
            return None
        if span == "month":
            return {self.key}
        if span == "year":
            return set(range(self.year * 12, self.year * 12 + 12))
        quarter_start = self.year * 12 + ((self.month - 1) // 3) * 3
        return set(range(quarter_start, quarter_start + 3))


def parse_moment(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    text = str(value)
    try:
        if len(text) == 10:
            parsed = datetime.combine(date.fromisoformat(text), datetime.min.time())
        else:
            parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def to_number(value: Any) -> float:
    try:
        return float(value) if value not in (None, "") else 0.0
    except (TypeError, ValueError):
        return 0.0


def pct_delta(current: float, previous: float) -> float | None:
    if not previous:
        return None
    return (current - previous) / abs(previous) * 100


class Source:
    """Записи и схема одного объекта (кэш на запрос: один проход на объект)."""

    def __init__(self, ctx: records.Ctx) -> None:
        self.ctx = ctx
        self._records: dict[str, list[dict[str, Any]]] = {}

    def entity(self, key: str) -> dict[str, Any]:
        entity_def = workspace.entity_def(self.ctx.db, self.ctx.company.id, key)
        if entity_def is None:
            raise StatsError("unknown_entity", f"Объект «{key}» не найден в схеме воркспейса", entity=key)
        return entity_def

    def records(self, key: str) -> list[dict[str, Any]]:
        if key not in self._records:
            self._records[key] = records.list_records(self.ctx, key)
        return self._records[key]


def _stage(entity_def: dict[str, Any], record: dict[str, Any]) -> str:
    key = entity_def.get("stageField")
    return str(record.get(key) or "") if key else ""


def is_won(entity_def, record) -> bool:
    return _stage(entity_def, record) in workspace.CLOSED_WON


def is_lost(entity_def, record) -> bool:
    return _stage(entity_def, record) in workspace.CLOSED_LOST


def is_open(entity_def, record) -> bool:
    return not entity_def.get("stageField") or not (is_won(entity_def, record) or is_lost(entity_def, record))


def record_date(entity_def: dict[str, Any], record: dict[str, Any]) -> datetime | None:
    key = entity_def.get("dateField")
    return parse_moment(record.get(key)) if key and record.get(key) else parse_moment(record.get("createdAt"))


def monthly(
    period: Period,
    keys: list[int],
    rows: list[dict[str, Any]],
    value: Callable[[dict[str, Any]], float],
    date_of: Callable[[dict[str, Any]], datetime | None],
) -> list[float]:
    buckets = {key: 0.0 for key in keys}
    for row in rows:
        key = period.month_key(date_of(row))
        if key in buckets:
            buckets[key] += value(row)
    return [buckets[key] for key in keys]


def _amount_field(entity_def: dict[str, Any], config: dict[str, Any]) -> str | None:
    return config.get("field") or entity_def.get("amountField") or None


# --------------------------------------------------------------------------- #
#  Виджеты
# --------------------------------------------------------------------------- #

def kpi(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "deals")
    rows = source.records(entity_def["key"])
    metric = config.get("metric") or "count"
    field = _amount_field(entity_def, config)
    amount = (lambda r: to_number(r.get(field))) if field else (lambda r: 0.0)
    stage_key = entity_def.get("stageField")

    pool = rows
    if config.get("filterStage") and stage_key:
        pool = [r for r in pool if r.get(stage_key) == config["filterStage"]]
    if config.get("excludeClosed"):
        pool = [r for r in pool if is_open(entity_def, r)]

    keys = period.keys(KPI_MONTHS)
    date_of = lambda r: record_date(entity_def, r)  # noqa: E731
    caption: dict[str, Any] = {"records": len(pool)}

    if metric == "conversion":
        won = [r for r in rows if is_won(entity_def, r)]
        closed = [r for r in rows if is_won(entity_def, r) or is_lost(entity_def, r)]
        value = len(won) / len(closed) * 100 if closed else 0.0
        won_m = monthly(period, keys, won, lambda r: 1.0, date_of)
        closed_m = monthly(period, keys, closed, lambda r: 1.0, date_of)
        series = [w / c * 100 if c else 0.0 for w, c in zip(won_m, closed_m)]
        delta = series[-1] - series[-2] if closed_m[-1] and closed_m[-2] else None
        caption.update(won=len(won), closed=len(closed))
        return {"value": value, "format": "percent", "series": series, "delta": delta, "deltaUnit": "pp", "caption": caption}

    if metric == "sum":
        value = sum(amount(r) for r in pool)
        series = monthly(period, keys, pool, amount, date_of)
        if config.get("target"):
            caption["target"] = to_number(config["target"])
    elif metric == "avg":
        value = sum(amount(r) for r in pool) / len(pool) if pool else 0.0
        sums = monthly(period, keys, pool, amount, date_of)
        counts = monthly(period, keys, pool, lambda r: 1.0, date_of)
        series = [s / c if c else 0.0 for s, c in zip(sums, counts)]
    else:
        value = float(len(pool))
        series = monthly(period, keys, pool, lambda r: 1.0, date_of)
        if entity_def.get("amountField"):
            caption["worth"] = sum(to_number(r.get(entity_def["amountField"])) for r in pool)
    fmt = "number" if metric == "count" else ("money" if field else "number")
    return {"value": value, "format": fmt, "series": series, "delta": pct_delta(series[-1], series[-2]), "deltaUnit": "%", "caption": caption}


def trend(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "deals")
    months = 12 if int(config.get("months") or 6) >= 12 else 6
    field = _amount_field(entity_def, config)
    stage_key = entity_def.get("stageField")
    rows = source.records(entity_def["key"])
    if config.get("filterStage") and stage_key:
        rows = [r for r in rows if r.get(stage_key) == config["filterStage"]]
    else:
        rows = [r for r in rows if not is_lost(entity_def, r)]
    value = (lambda r: to_number(r.get(field))) if field else (lambda r: 1.0)
    date_of = lambda r: record_date(entity_def, r)  # noqa: E731

    keys = period.keys(months)
    actual = monthly(period, keys, rows, value, date_of)
    target = to_number(config.get("target"))
    if target:
        compare = [target * (i + 1) / months for i in range(months)]
        compare_kind = "plan"
    else:
        previous = monthly(period, period.keys(months, offset=months), rows, value, date_of)
        compare = [sum(previous[: i + 1]) for i in range(months)]
        compare_kind = "previous"
    points, running = [], 0.0
    for i, key in enumerate(keys):
        running += actual[i]
        points.append({"month": Period.label(key), "actual": running, "compare": compare[i]})
    return {"points": points, "compareKind": compare_kind, "money": bool(field)}


def funnel(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "deals")
    stage_key = entity_def.get("stageField")
    if not stage_key:
        raise StatsError("no_stage_field", "У объекта нет поля стадии")
    stage_field = workspace.field_def(entity_def, stage_key) or {}
    options = [o for o in stage_field.get("options") or [] if o.get("value") not in workspace.CLOSED_LOST]
    index = {o["value"]: i for i, o in enumerate(options)}
    rows = source.records(entity_def["key"])
    positions = [index[r.get(stage_key)] for r in rows if r.get(stage_key) in index]
    stages = [
        {"value": o["value"], "label": o.get("label", o["value"]), "count": sum(1 for p in positions if p >= i)}
        for i, o in enumerate(options)
    ]
    conversion = stages[-1]["count"] / stages[0]["count"] * 100 if stages and stages[0]["count"] else 0.0
    cycles = []
    for r in rows:
        if is_won(entity_def, r):
            created, closed = parse_moment(r.get("createdAt")), parse_moment(r.get("closedAt"))
            if created and closed and closed >= created:
                cycles.append((closed - created).total_seconds() / 86400)
    return {
        "stages": stages,
        "conversion": conversion,
        "medianCycleDays": round(statistics.median(cycles), 1) if cycles else None,
    }


def top_records(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "deals")
    amount_key = entity_def.get("amountField")
    rows = [r for r in source.records(entity_def["key"]) if is_open(entity_def, r)]
    if amount_key:
        rows.sort(key=lambda r: to_number(r.get(amount_key)), reverse=True)
    limit = max(1, min(50, int(config.get("limit") or 5)))
    return {"ids": [r["id"] for r in rows[:limit]], "open": len(rows)}


def agenda(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "tasks")
    if not entity_def.get("dateField"):
        raise StatsError("no_date_field", "У объекта нет поля даты")
    now_local = datetime.now(period.tz)
    start = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    upcoming = []
    for r in source.records(entity_def["key"]):
        when = parse_moment(r.get(entity_def["dateField"]))
        if when and when >= start and is_open(entity_def, r):
            upcoming.append((when, r))
    upcoming.sort(key=lambda item: item[0])
    limit = max(1, min(50, int(config.get("limit") or 4)))
    today = sum(1 for when, _ in upcoming if when.astimezone(period.tz).date() == now_local.date())
    return {"ids": [r["id"] for _, r in upcoming[:limit]], "today": today}


def leaderboard(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "deals")
    owner_key = entity_def.get("ownerField")
    if not owner_key:
        raise StatsError("no_owner_field", "У объекта нет поля ответственного")
    amount_key = entity_def.get("amountField")
    table: dict[str, dict[str, Any]] = {}
    for r in source.records(entity_def["key"]):
        owner = r.get(owner_key)
        if not owner:
            continue
        row = table.setdefault(owner, {"owner": owner, "count": 0, "won": 0, "value": 0.0})
        row["count"] += 1
        if is_won(entity_def, r):
            row["won"] += 1
            row["value"] += to_number(r.get(amount_key)) if amount_key else 1.0
    rows = sorted(table.values(), key=lambda x: (-x["value"], -x["won"], x["owner"]))
    return {"rows": rows, "money": bool(amount_key)}


def goal(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "deals")
    amount_key = entity_def.get("amountField")
    span = config.get("range") or "quarter"
    keys = period.range_keys(span)
    value = 0.0
    for r in source.records(entity_def["key"]):
        if not is_won(entity_def, r):
            continue
        if keys is not None and period.month_key(record_date(entity_def, r)) not in keys:
            continue
        value += to_number(r.get(amount_key)) if amount_key else 1.0
    target = to_number(config.get("target")) or 0.0
    return {"value": value, "target": target, "pct": min(100.0, value / target * 100) if target else 0.0, "range": span, "money": bool(amount_key)}


def _distribution(entity_def: dict[str, Any], rows: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    fdef = workspace.field_def(entity_def, key) or {}
    counts: dict[Any, int] = defaultdict(int)
    for r in rows:
        values = r.get(key) if isinstance(r.get(key), list) else [r.get(key)]
        for value in values:
            if value not in (None, ""):
                counts[value] += 1
    ordered = [o["value"] for o in fdef.get("options") or []]
    ordered += [v for v in counts if v not in ordered]
    return [{"value": v, "label": workspace.option_label(fdef, v), "count": counts.get(v, 0)} for v in ordered]


def breakdown(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "deals")
    key = config.get("field") or next(
        (f["key"] for f in entity_def.get("fields", []) if f.get("type") in ("select", "status")), None
    )
    if not key:
        raise StatsError("no_select_field", "У объекта нет поля-списка")
    rows = source.records(entity_def["key"])
    slices = [s for s in _distribution(entity_def, rows, key) if s["count"]]
    return {"field": key, "slices": slices, "total": sum(s["count"] for s in slices)}


def stage_summary(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    entity_def = source.entity(config.get("entity") or "tasks")
    if not entity_def.get("stageField"):
        raise StatsError("no_stage_field", "У объекта нет поля стадии")
    rows = source.records(entity_def["key"])
    return {"stages": _distribution(entity_def, rows, entity_def["stageField"]), "total": len(rows)}


def my_day(source: Source, period: Period, config: dict[str, Any]) -> dict[str, Any]:
    """Сводка для приветствия: открытые записи на мне и сроки сегодня — по всем объектам."""
    actor = source.ctx.actor
    me = f"u_{actor.id}" if actor else None
    today = datetime.now(period.tz).date()
    open_assigned = due_today = 0
    for entity_def in workspace.entity_defs(source.ctx.db, source.ctx.company.id).values():
        owner_key, date_key = entity_def.get("ownerField"), entity_def.get("dateField")
        if not owner_key or me is None:
            continue
        for r in source.records(entity_def["key"]):
            if r.get(owner_key) != me or not is_open(entity_def, r):
                continue
            open_assigned += 1
            when = parse_moment(r.get(date_key)) if date_key else None
            if when and when.astimezone(period.tz).date() == today:
                due_today += 1
    return {"openAssigned": open_assigned, "dueToday": due_today}


WIDGETS: dict[str, Callable[[Source, Period, dict[str, Any]], dict[str, Any]]] = {
    "kpi": kpi,
    "trend": trend,
    "funnel": funnel,
    "records": top_records,
    "agenda": agenda,
    "leaderboard": leaderboard,
    "goal": goal,
    "breakdown": breakdown,
    "stages": stage_summary,
    "my_day": my_day,
}


def widget_data(source: Source, period: Period, widget_type: str, config: dict[str, Any]) -> dict[str, Any]:
    compute = WIDGETS.get(widget_type)
    if compute is None:
        raise StatsError("unknown_widget", f"Виджет «{widget_type}» считается в браузере или не существует")
    return compute(source, period, config)


# --------------------------------------------------------------------------- #
#  Отчёты
# --------------------------------------------------------------------------- #

def report(source: Source, *, entity: str, group_by: str, metric: str, metric_field: str | None) -> list[dict[str, Any]]:
    """Группы в порядке опций поля (для select/status), дальше — по убыванию меры."""
    entity_def = source.entity(entity)
    if metric not in ("count", "sum", "avg"):
        raise StatsError("invalid_metric", "Мера — count, sum или avg")
    if metric != "count" and not metric_field:
        raise StatsError("missing_metric_field", "Для суммы и среднего выберите числовое поле")
    fdef = workspace.field_def(entity_def, group_by) or {}
    groups: dict[str, list[float]] = defaultdict(list)
    for r in source.records(entity):
        raw = r.get(group_by)
        keys = raw if isinstance(raw, list) and raw else [raw]
        for key in keys:
            label_key = "" if key in (None, "") else (str(key).lower() if isinstance(key, bool) else str(key))
            groups[label_key].append(to_number(r.get(metric_field)) if metric_field else 1.0)

    def measure(values: list[float]) -> float:
        if metric == "count":
            return float(len(values))
        total = sum(values)
        return total if metric == "sum" else (total / len(values) if values else 0.0)

    rows = [{"key": key or None, "value": measure(values)} for key, values in groups.items()]
    rows = [row for row in rows if row["value"] > 0]
    order = {o["value"]: i for i, o in enumerate(fdef.get("options") or [])}
    rows.sort(key=lambda row: (order.get(row["key"], len(order)), -row["value"]))
    return rows
