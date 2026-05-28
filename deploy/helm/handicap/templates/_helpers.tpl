{{/* Generate fullname */}}
{{- define "handicap.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default "handicap" .Values.nameOverride -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "handicap.controller.fullname" -}}
{{- printf "%s-controller" (include "handicap.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "handicap.labels" -}}
app.kubernetes.io/name: handicap
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end -}}

{{- define "handicap.selectorLabels" -}}
app.kubernetes.io/name: handicap
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "handicap.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "handicap.controller.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "handicap.workerImage" -}}
{{- if .Values.worker.image -}}
{{- .Values.worker.image -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository .Values.image.tag -}}
{{- end -}}
{{- end -}}
