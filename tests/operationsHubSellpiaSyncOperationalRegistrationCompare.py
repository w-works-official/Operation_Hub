"""Read-only date classification of source-only hashed SKU keys. Aggregate output only."""
import argparse
import csv
import hashlib
import io
import json
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

def classify(value, baseline_day):
    text = value.strip()
    try:
        parsed = date.fromisoformat(text)
    except ValueError:
        return "unparseable", None
    return "before" if parsed < baseline_day else "after" if parsed > baseline_day else "on", parsed

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-directory", required=True)
    parser.add_argument("--private-projection", required=True)
    parser.add_argument("--report", required=True)
    args = parser.parse_args()
    directory = Path(args.run_directory)
    if directory.name != "804883ac-0600-4ea6-89c7-24d69e37995e":
        raise ValueError("QA_RUN_SCOPE")
    projection = json.loads(Path(args.private_projection).read_text(encoding="utf-8"))
    db_keys = {row["key"] for row in projection["rows"]}
    report_path = Path(args.report)
    report = json.loads(report_path.read_text(encoding="utf-8"))
    baseline_stamp = datetime.fromisoformat(report["dbSnapshotBefore"]["completedAt"])
    baseline_day = baseline_stamp.astimezone(ZoneInfo("Asia/Seoul")).date()
    journal = json.loads((directory / "journal.json").read_text(encoding="utf-8"))
    statuses = ["정상", "품절", "단종", "(missing_or_other)"]
    categories = ["before", "on", "after", "unparseable"]
    fields = {name: {"counts": {c: 0 for c in categories}, "byStatus": {s: {c: 0 for c in categories} for s in statuses}, "minDate": None, "maxDate": None} for name in ["등록일", "실등록일"]}
    selected = 0
    for index, declared in enumerate(journal["files"]):
        filename = directory / f"part-{index + 1}.csv"
        raw = filename.read_bytes()
        if len(raw) != declared["size"] or hashlib.sha256(raw).hexdigest() != declared["sha256"]:
            raise ValueError("QA_SOURCE_CHANGED")
        reader = csv.DictReader(io.StringIO(raw.decode("utf-8").lstrip("\ufeff"), newline=""))
        for row in reader:
            key = hashlib.md5(row["상품코드"].strip().encode("utf-8")).hexdigest()
            if key in db_keys:
                continue
            selected += 1
            state = "단종" if row["단종"].strip() else "품절" if row["품절"].strip() else "정상"
            for name, aggregate in fields.items():
                category, parsed = classify(row.get(name, ""), baseline_day)
                aggregate["counts"][category] += 1
                aggregate["byStatus"][state][category] += 1
                if parsed:
                    value = parsed.isoformat()
                    aggregate["minDate"] = min(aggregate["minDate"], value) if aggregate["minDate"] else value
                    aggregate["maxDate"] = max(aggregate["maxDate"], value) if aggregate["maxDate"] else value
    if selected != report["sourceOnlySkuCount"]:
        raise ValueError("QA_SOURCE_ONLY_COUNT_CHANGED")
    classification = {"sourceOnlySkuCount": selected, "baselineCompletedAt": report["dbSnapshotBefore"]["completedAt"],
                      "baselineCalendarDateKst": baseline_day.isoformat(), "datePrecision": "day only in both original CSV columns",
                      "comparisonBasis": "KST calendar date: before/on/after October 8. On means same date; exact relation to 15:14:07 cannot be recovered from date-only cells.",
                      "fields": fields,
                      "interpretationLimit": "Registration-date and state correlation does not establish why a SKU is absent from the earlier DB snapshot. These counts are not approved apply targets."}
    report["sourceOnlyRegistrationDateClassification"] = classification
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    text_path = report_path.with_suffix(".txt")
    extra = ["", "실제 파일에만 존재하는 3,515 SKU의 등록일 보조 대조:",
             "CSV 등록일/실등록일은 시각 없이 YYYY-MM-DD만 제공한다. before/on/after는 KST 2026-10-08 날짜 기준이며, on은 15:14:07 이전/이후를 구별할 수 없다."]
    for name, aggregate in fields.items():
        extra.append(f"{name}: {json.dumps(aggregate['counts'], ensure_ascii=False)}; 상태별 {json.dumps(aggregate['byStatus'], ensure_ascii=False)}.")
    extra.append("등록 날짜·상태와 DB 누락의 원인을 동일시하지 않는다. 신규 등록과 기존 단종 범위를 구분하는 보조 자료이며 실제 반영 승인 목록은 아니다.")
    with text_path.open("a", encoding="utf-8") as handle:
        handle.write("\n".join(extra) + "\n")
    print(json.dumps(classification, ensure_ascii=True))

if __name__ == "__main__":
    main()
