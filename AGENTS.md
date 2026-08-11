# AGENTS.md — PYGEM

## Regras do ecossistema

Este projeto faz parte do pipeline de preparação de conteúdo para LEIAUT, SITE_ANTIG e TESOURA. O agente deve:

- preservar o contrato de entrada e saída do pipeline, especialmente a estrutura de Markdown e os metadados de reescrita;
- não introduzir mudanças que comprometam a posterior importação, leitura ou interpretação do conteúdo jurídico;
- manter o processamento determinístico, seguro e local, sem depender de comportamento ad hoc da IA;
- evitar alterações que gerem perda de conteúdo, reescrita indevida ou quebra de ordem e hierarquia dos tópicos;
- validar o resultado antes de concluir qualquer ajuste.

## Escopo

O agente está autorizado a criar e alterar arquivos dentro de `C:\PYGEM`.

Não criar, alterar ou apagar arquivos fora deste diretório.

## Segurança

Não ler ou modificar credenciais, arquivos `.env`, tokens, chaves, contas de serviço ou conteúdo interno de `.git`.

## Qualidade

Antes de alterar arquivos:

1. analisar o estado atual;
2. explicar o plano;
3. identificar os riscos;
4. limitar o escopo;
5. implementar e verificar.

## Regras específicas do projeto

- preservar a fidelidade do conteúdo original e não inventar informações jurídicas;
- manter a estrutura Markdown, títulos, listas e marcações úteis;
- não alterar o sentido do texto sem autorização explícita;
- quando a saída for afetada por validação editorial, preferir correções conservadoras e localizadas;
- validar as mudanças com os testes locais relevantes, como `npm run test:mermaid` e `npm run test:core`, sempre que aplicável.
