"""
Данные виджетов дашборда и отчётов — формулы в stats.py.
"""

from __future__ import annotations

from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

import models
import records
import schemas
import stats
from core.database import get_db
from core.deps import get_current_company, get_current_user
from core.errors import DomainError

router = APIRouter(prefix="/companies/{company_id}/analytics", tags=["analytics"])


@router.post("/widgets", response_model=schemas.WidgetsOut)
def widgets(
    payload: schemas.WidgetsIn,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.WidgetsOut:
    """Пачка виджетов одного дашборда: записи каждого объекта читаются один раз."""
    source = stats.Source(records.Ctx(db, company, user))
    period = stats.Period(payload.period.year, payload.period.month, ZoneInfo(company.timezone or "UTC"))
    results: dict[str, dict] = {}
    for widget in payload.widgets:
        try:
            results[widget.id] = {"data": stats.widget_data(source, period, widget.type, widget.config)}
        except DomainError as exc:
            results[widget.id] = {"error": {"code": exc.code, "message": exc.message}}
    return schemas.WidgetsOut(results=results)


@router.post("/report", response_model=schemas.ReportRows)
def report(
    payload: schemas.ReportQuery,
    company: models.Company = Depends(get_current_company),
    user: models.User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> schemas.ReportRows:
    source = stats.Source(records.Ctx(db, company, user))
    rows = stats.report(
        source,
        entity=payload.entity,
        group_by=payload.group_by,
        metric=payload.metric,
        metric_field=payload.metric_field,
    )
    return schemas.ReportRows(rows=rows)
