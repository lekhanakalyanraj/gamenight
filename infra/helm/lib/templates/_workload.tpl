{{/*
Shared templates for gamenight's services. Each service chart sets its values and includes these, so every pod
runs the same way: the `restricted` Pod Security profile, a read-only root filesystem with small writable
emptyDirs where the program needs them, probes, requests and limits, no service account token, and a
NetworkPolicy built from the links the service declares.
*/}}

{{/* The labels the network policies select on: one name per service. */}}
{{- define "lib.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "lib.labels" -}}
{{ include "lib.selectorLabels" . }}
app.kubernetes.io/part-of: gamenight
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{/* repository:tag, or repository@digest when a digest is pinned (a real registry). */}}
{{- define "lib.image" -}}
{{- $image := .Values.image -}}
{{- if $image.digest -}}
{{ $image.repository }}@{{ $image.digest }}
{{- else -}}
{{ $image.repository }}:{{ required "image.tag or image.digest is required" $image.tag }}
{{- end -}}
{{- end }}

{{- define "lib.probe" -}}
{{- if .Values.probe.path }}
httpGet:
  path: {{ .Values.probe.path }}
  port: http
{{- else }}
tcpSocket:
  port: http
{{- end }}
{{- end }}

{{- define "lib.deployment" -}}
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ .Chart.Name }}
  labels:
    {{- include "lib.labels" . | nindent 4 }}
spec:
  {{- if not (.Values.autoscaling | default dict).enabled }}
  replicas: {{ .Values.replicas | default 1 }}
  {{- end }}
  revisionHistoryLimit: 3
  {{- if .Values.persistence }}
  strategy:
    type: Recreate  # one pod at a time on its volume
  {{- end }}
  selector:
    matchLabels:
      {{- include "lib.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      labels:
        {{- include "lib.labels" . | nindent 8 }}
    spec:
      automountServiceAccountToken: false  # no service talks to the Kubernetes API
      enableServiceLinks: false
      securityContext:
        runAsNonRoot: true
        runAsUser: {{ .Values.user }}
        runAsGroup: {{ .Values.group | default .Values.user }}
        fsGroup: {{ .Values.group | default .Values.user }}
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: {{ .Chart.Name }}
          image: {{ include "lib.image" . }}
          imagePullPolicy: {{ .Values.image.pullPolicy | default "IfNotPresent" }}
          {{- with .Values.args }}
          args:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          ports:
            - name: http
              containerPort: {{ .Values.port }}
              protocol: TCP
          {{- with .Values.env }}
          env:
            {{- range $name, $value := . }}
            - name: {{ $name }}
              value: {{ $value | toString | quote }}
            {{- end }}
          {{- end }}
          {{- if .Values.secret }}
          envFrom:
            - secretRef:
                name: {{ .Chart.Name }}  # made by make kind-secrets: each service gets only its own
          {{- end }}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: [ALL]
          readinessProbe:
            {{- include "lib.probe" . | nindent 12 }}
            periodSeconds: 5
            failureThreshold: 3
          livenessProbe:
            {{- include "lib.probe" . | nindent 12 }}
            initialDelaySeconds: {{ .Values.probe.initialDelaySeconds | default 10 }}
            periodSeconds: 15
            failureThreshold: 4
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          {{- if or .Values.writable .Values.persistence }}
          volumeMounts:
            {{- range .Values.writable }}
            - name: {{ .name }}
              mountPath: {{ .path }}
            {{- end }}
            {{- with .Values.persistence }}
            - name: {{ .name }}
              mountPath: {{ .path }}
            {{- end }}
          {{- end }}
      {{- if or .Values.writable .Values.persistence }}
      volumes:
        {{- range .Values.writable }}
        - name: {{ .name }}
          emptyDir:
            sizeLimit: {{ .size | default "64Mi" }}
        {{- end }}
        {{- with .Values.persistence }}
        - name: {{ .name }}
          persistentVolumeClaim:
            claimName: {{ $.Chart.Name }}
        {{- end }}
      {{- end }}
{{- end }}

{{/* Data that must outlive a pod (a restart must not empty the Agent Server's Postgres under it). */}}
{{- define "lib.pvc" -}}
{{- with .Values.persistence }}
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: {{ $.Chart.Name }}
  labels:
    {{- include "lib.labels" $ | nindent 4 }}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: {{ .size }}
{{- end }}
{{- end }}

{{- define "lib.service" -}}
{{- $service := .Values.service | default dict -}}
apiVersion: v1
kind: Service
metadata:
  name: {{ .Chart.Name }}
  labels:
    {{- include "lib.labels" . | nindent 4 }}
spec:
  type: {{ $service.type | default "ClusterIP" }}
  selector:
    {{- include "lib.selectorLabels" . | nindent 4 }}
  ports:
    - name: http
      port: {{ $service.port | default .Values.port }}
      targetPort: http
      protocol: TCP
      {{- with $service.nodePort }}
      nodePort: {{ . }}
      {{- end }}
{{- end }}

{{/*
The service's own NetworkPolicy. The namespace denies everything by default (the umbrella chart), so this
allows only what the service declares under `network`:
  ingressFromAnywhere: true    anyone may connect to its port (web, reached through the NodePort)
  ingressFrom: [web, ...]      only these services may connect to its port
  egressTo: [{app, port}]      the services it calls
  supabase: [api, db]          the Supabase ports it uses, on the host outside the cluster
  internet: true               HTTPS to public addresses (model and voice providers), never private ranges
*/}}
{{- define "lib.networkpolicy" -}}
{{- $net := .Values.network | default dict -}}
{{- $supabase := .Values.global.supabase -}}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ .Chart.Name }}
  labels:
    {{- include "lib.labels" . | nindent 4 }}
spec:
  # By name only: the network-policy test's probe pods carry a service's name (so its policy governs them) but a
  # different instance, so the service's ReplicaSet never adopts them and its Service never sends them traffic.
  podSelector:
    matchLabels:
      app.kubernetes.io/name: {{ .Chart.Name }}
  policyTypes: [Ingress, Egress]
  {{- if $net.ingressFromAnywhere }}
  ingress:
    - ports:
        - port: {{ .Values.port }}
          protocol: TCP
  {{- else if $net.ingressFrom }}
  ingress:
    - from:
        {{- range $net.ingressFrom }}
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: {{ . }}
        {{- end }}
      ports:
        - port: {{ .Values.port }}
          protocol: TCP
  {{- else }}
  ingress: []
  {{- end }}
  {{- if or $net.egressTo $net.supabase $net.internet }}
  egress:
    {{- range $net.egressTo }}
    - to:
        - podSelector:
            matchLabels:
              app.kubernetes.io/name: {{ .app }}
      ports:
        - port: {{ .port }}
          protocol: TCP
    {{- end }}
    {{- with $net.supabase }}
    - to:
        - ipBlock:
            cidr: {{ required "global.supabase.hostIP is required (make kind-deploy sets it)" $supabase.hostIP }}/32
      ports:
        {{- range . }}
        - port: {{ index $supabase.ports . }}
          protocol: TCP
        {{- end }}
    {{- end }}
    {{- if $net.internet }}
    - to:
        - ipBlock:
            cidr: 0.0.0.0/0
            except: [10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, 100.64.0.0/10, 127.0.0.0/8]
      ports:
        - port: 443
          protocol: TCP
    {{- end }}
  {{- else }}
  egress: []
  {{- end }}
{{- end }}

{{/* Scales the service on CPU (the example is the Agent Server: its replicas share one run queue). */}}
{{- define "lib.hpa" -}}
{{- with .Values.autoscaling }}
{{- if .enabled }}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ $.Chart.Name }}
  labels:
    {{- include "lib.labels" $ | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ $.Chart.Name }}
  minReplicas: {{ .minReplicas }}
  maxReplicas: {{ .maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .cpuPercent }}
{{- end }}
{{- end }}
{{- end }}
