#!/usr/bin/env python3
"""Valida lotes e cria cópias do payload original com comentários revisados."""

import argparse
import collections
import hashlib
import json
import re
from pathlib import Path


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def expected_batches(root, counts):
    issues = []
    for name, count in counts.items():
        folder = root / name
        expected = (count + 9) // 10
        existing = {int(p.stem) for p in folder.glob("[0-9][0-9][0-9][0-9].json")}
        missing = sorted(set(range(1, expected + 1)) - existing)
        if missing:
            issues.append({"group": name, "missing_batches": missing})
    return issues


def clean_statement(question):
    if not question["external_id"].startswith("pdf:dpf14_009_01:"):
        if re.search(r"\bJUSTIFICATIVA\s+[–—-]\s+", question["statement_markdown"]):
            raise ValueError(f"Justificativa oficial não tratada: {question['external_id']}")
        return
    parts = re.split(r"\s+JUSTIFICATIVA\s+[–—-]\s+", question["statement_markdown"])
    if len(parts) != 2 or not all(part.strip() for part in parts):
        raise ValueError(f"Justificativa oficial não separável: {question['external_id']}")
    question["statement_markdown"] = parts[0].rstrip()
    question["source_metadata"]["statement_cleanup"] = "justificativa_oficial_separada_v1"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input_dir", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    root = args.output_dir
    expected = expected_batches(root, {
        "lotes": 618,
        "lotes_reconciliados": 416,
        "lotes_mprj": 80,
        "lotes_escriturario": 69,
        "lotes_cargo30": 119,
    })
    if expected:
        raise ValueError(f"Lotes incompletos: {expected}")
    batches = sorted(p for folder in root.glob("lotes*") if folder.is_dir()
                     for p in folder.glob("[0-9][0-9][0-9][0-9].json"))
    reviewed = {}
    duplicate_ids = []
    for file in batches:
        data = load(file)
        if len(data["questions"]) > 10:
            raise ValueError(f"Lote com mais de 10 itens: {file}")
        if any(item["external_id"].startswith("pdf:dpf14_009_01:")
               for item in data["questions"]) and data.get("statement_cleaned") is not True:
            raise ValueError(f"Lote PF 2014 gerado com justificativa no enunciado: {file}")
        for item in data["questions"]:
            key = item["external_id"]
            if key in reviewed:
                duplicate_ids.append(key)
            reviewed[key] = (item, file)
    if duplicate_ids:
        raise ValueError(f"IDs duplicados: {duplicate_ids[:10]}")

    originals = sorted(p for p in args.input_dir.glob("*.json") if p.name != "relatorio_validacao.json")
    all_questions = {}
    for file in originals:
        for question in load(file)["questions"]:
            key = question["external_id"]
            if key in all_questions:
                raise ValueError(f"ID duplicado na origem: {key}")
            all_questions[key] = question
    extra_ids = sorted(set(reviewed) - set(all_questions))
    if extra_ids:
        raise ValueError(f"Comentários sem origem: {extra_ids[:10]}")

    reconciliation = {}
    for file in root.glob("reconciliacao_*.json"):
        for item in load(file).get("items", []):
            key = item["external_id"]
            if key in reconciliation:
                raise ValueError(f"Reconciliação duplicada: {key}")
            reconciliation[key] = item

    audit_file = root / "auditoria_independente.json"
    independent_holds = {item["external_id"]: item
                         for item in load(audit_file).get("items", [])} if audit_file.exists() else {}
    pro_audit = {}
    for file in (root / "auditoria_pro").glob("lotes*/*.json"):
        for item in load(file)["items"]:
            key = item["id"]
            if key in pro_audit:
                raise ValueError(f"ID repetido na auditoria Pro: {key}")
            pro_audit[key] = item
    missing_audit = sorted(key for key, (result, _) in reviewed.items()
                           if result["status"] == "comentada" and key not in pro_audit)
    if missing_audit:
        raise ValueError(f"Auditoria Pro incompleta: {len(missing_audit)} IDs, exemplo {missing_audit[:5]}")
    stale_audit = sorted(key for key, (result, _) in reviewed.items()
                         if result["status"] == "comentada" and
                         pro_audit[key].get("comment_sha256") != hashlib.sha256(
                             result["comment_markdown"].encode("utf-8")).hexdigest())
    if stale_audit:
        raise ValueError(f"Auditoria Pro obsoleta: {len(stale_audit)} IDs, exemplo {stale_audit[:5]}")

    counts = collections.Counter()
    holds = []
    output_files = []
    for file in originals:
        data = load(file)
        for question in data["questions"]:
            clean_statement(question)
            key = question["external_id"]
            result_pair = reviewed.get(key)
            if not result_pair:
                rec = reconciliation.get(key)
                reason = "sem_lote"
                if rec and rec["status"] in {"annulled", "blocked_unmatched"}:
                    reason = f"gabarito_{rec['status']}"
                elif question["correct_option_label"] is None:
                    reason = "sem_gabarito_seguro_ou_anulada"
                counts["nao_processada"] += 1
                holds.append({"external_id": key, "reason": reason})
                question["explanation"] = None
                question["import_ready"] = False
                continue
            result, batch_file = result_pair
            rec = reconciliation.get(key)
            if rec and rec["status"] not in {"confirmed", "changed"}:
                raise ValueError(f"Comentário para gabarito não confirmado: {key}")
            if key in independent_holds:
                question["explanation"] = None
                question["import_ready"] = False
                counts["retida_auditoria_independente"] += 1
                holds.append({"external_id": key, "reason": independent_holds[key]["reason"]})
                continue
            pro = pro_audit.get(key)
            if result["status"] == "comentada" and (not pro["approve"] or pro.get("needs_red_update")):
                question["explanation"] = None
                question["import_ready"] = False
                counts["retida_auditoria_pro"] += 1
                holds.append({"external_id": key, "reason": pro["reason"]})
                continue
            if result["status"] == "comentada":
                if not result.get("comment_markdown"):
                    raise ValueError(f"Comentário vazio: {key}")
                if result.get("calculation_steps") and not Path(result.get("calculation_image", "")).is_file():
                    raise ValueError(f"Imagem ausente: {key}")
                if result.get("outdated_notice") and "🔴" not in result["comment_markdown"]:
                    raise ValueError(f"Aviso vermelho ausente: {key}")
                question["explanation"] = result["comment_markdown"]
                question["correct_option_label"] = result["correct_option_label"]
                question["source_metadata"]["commentary_review"] = {
                    "status": "revisada_por_modelo",
                    "batch": batch_file.parent.name + "/" + batch_file.name,
                    "legal_basis": result.get("legal_basis"),
                    "outdated_notice": result.get("outdated_notice"),
                    "calculation_image": result.get("calculation_image"),
                    "batch_grounding_urls": result.get("batch_grounding_urls", result.get("grounding_urls", [])),
                }
                counts["comentada"] += 1
            else:
                question["explanation"] = None
                counts["retida"] += 1
                holds.append({"external_id": key, "reason": result.get("hold_reason")})
            question["import_ready"] = False
        target = root / "arquivos_site" / file.name
        save(target, data)
        output_files.append(str(target))

    report = {
        "total_questions": len(all_questions),
        "counts": dict(counts),
        "processed": len(reviewed),
        "missing_batches": expected,
        "holds": holds,
        "output_files": output_files,
    }
    save(root / "relatorio_comentarios.json", report)
    print(json.dumps({k: v for k, v in report.items() if k not in {"holds", "output_files"}}, ensure_ascii=False))


if __name__ == "__main__":
    main()
