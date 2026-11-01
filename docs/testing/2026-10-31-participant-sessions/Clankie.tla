---- MODULE Clankie ----
\* Routing design, not a claim that every transition is implemented.
\* The room has its own isolated session; its harness never grants owner authority.
EXTENDS Naturals, FiniteSets

VARIABLES mac, seat, piModel, workerLive, appLive, roomLive,
          kind, status, runner, resumeRunner, resumeWasAvailable

vars == <<mac, seat, piModel, workerLive, appLive, roomLive,
          kind, status, runner, resumeRunner, resumeWasAvailable>>

Available(r) ==
  CASE r = "seat"   -> seat = "live"
    [] r = "pi"     -> piModel
    [] r = "worker" -> workerLive
    [] r = "app"    -> appLive
    [] r = "room"   -> roomLive
    [] OTHER         -> FALSE

FallbackRunner ==
  IF kind = "social" THEN IF roomLive THEN "room" ELSE "none"
  ELSE IF kind = "tagOwned" /\ workerLive THEN "worker"
  ELSE IF seat = "live" THEN "seat"
  ELSE IF piModel THEN "pi"
  ELSE IF appLive THEN "app"
  ELSE "none"

\* A still-live previous runner wins even if another brain has appeared.
PreferredRunner == IF Available(resumeRunner) THEN resumeRunner ELSE FallbackRunner

Init ==
  /\ mac = "awake"
  /\ seat \in {"live", "none"}
  /\ piModel \in BOOLEAN
  /\ workerLive \in BOOLEAN
  /\ appLive \in BOOLEAN
  /\ roomLive \in BOOLEAN
  /\ kind = "none"
  /\ status = "idle"
  /\ runner = "none"
  /\ resumeRunner = "none"
  /\ resumeWasAvailable = FALSE

Arrive ==
  /\ status = "idle" /\ mac = "awake"
  /\ kind' \in {"tag", "tagOwned", "social"}
  /\ status' = "arrived"
  /\ runner' = "none" /\ resumeRunner' = "none" /\ resumeWasAvailable' = FALSE
  /\ UNCHANGED <<mac, seat, piModel, workerLive, appLive, roomLive>>

Route ==
  /\ status = "arrived" /\ mac = "awake"
  /\ runner' = PreferredRunner
  /\ status' = IF PreferredRunner # "none" THEN "working"
                ELSE IF kind = "social" THEN "notServed" ELSE "held"
  /\ resumeWasAvailable' = Available(resumeRunner)
  /\ UNCHANGED <<mac, seat, piModel, workerLive, appLive, roomLive, kind, resumeRunner>>

Finish ==
  /\ status = "working" /\ mac = "awake"
  /\ status' = "answered"
  /\ runner' = "none" /\ resumeRunner' = "none" /\ resumeWasAvailable' = FALSE
  /\ UNCHANGED <<mac, seat, piModel, workerLive, appLive, roomLive, kind>>

Reset ==
  /\ status \in {"answered", "notServed"}
  /\ status' = "idle" /\ kind' = "none"
  /\ runner' = "none" /\ resumeRunner' = "none" /\ resumeWasAvailable' = FALSE
  /\ UNCHANGED <<mac, seat, piModel, workerLive, appLive, roomLive>>

\* Availability changes wake held owner work through the core, without a pull.
WakeHeld ==
  /\ status' = IF status = "held" THEN "arrived" ELSE status
  /\ UNCHANGED <<runner, resumeRunner, resumeWasAvailable>>

SeatStarts ==
  /\ seat = "none" /\ mac = "awake" /\ seat' = "live"
  /\ WakeHeld
  /\ UNCHANGED <<mac, piModel, workerLive, appLive, roomLive, kind>>

PiStarts ==
  /\ ~piModel /\ mac = "awake" /\ piModel' = TRUE
  /\ WakeHeld
  /\ UNCHANGED <<mac, seat, workerLive, appLive, roomLive, kind>>

AppReadsInbox ==
  /\ ~appLive /\ mac = "awake" /\ appLive' = TRUE
  /\ WakeHeld
  /\ UNCHANGED <<mac, seat, piModel, workerLive, roomLive, kind>>

RoomStarts ==
  /\ ~roomLive /\ mac = "awake" /\ roomLive' = TRUE
  /\ WakeHeld
  /\ UNCHANGED <<mac, seat, piModel, workerLive, appLive, kind>>

InterruptIfOn(r) ==
  IF runner = r
  THEN /\ status' = IF mac = "awake" THEN "arrived" ELSE "paused"
       /\ runner' = "none" /\ resumeRunner' = r /\ resumeWasAvailable' = FALSE
  ELSE UNCHANGED <<status, runner, resumeRunner, resumeWasAvailable>>

SeatStops ==
  /\ seat = "live" /\ seat' = "none" /\ InterruptIfOn("seat")
  /\ UNCHANGED <<mac, piModel, workerLive, appLive, roomLive, kind>>

PiStops ==
  /\ piModel /\ piModel' = FALSE /\ InterruptIfOn("pi")
  /\ UNCHANGED <<mac, seat, workerLive, appLive, roomLive, kind>>

AppStops ==
  /\ appLive /\ appLive' = FALSE /\ InterruptIfOn("app")
  /\ UNCHANGED <<mac, seat, piModel, workerLive, roomLive, kind>>

RoomStops ==
  /\ roomLive /\ roomLive' = FALSE /\ InterruptIfOn("room")
  /\ UNCHANGED <<mac, seat, piModel, workerLive, appLive, kind>>

WorkerStops ==
  /\ workerLive /\ workerLive' = FALSE /\ InterruptIfOn("worker")
  /\ UNCHANGED <<mac, seat, piModel, appLive, roomLive, kind>>

WorkerComesOrGoes ==
  /\ status = "idle" /\ workerLive' = ~workerLive
  /\ UNCHANGED <<mac, seat, piModel, appLive, roomLive, kind, status,
                 runner, resumeRunner, resumeWasAvailable>>

Sleep ==
  /\ mac = "awake" /\ mac' = "asleep"
  /\ IF status \in {"working", "arrived"}
       THEN /\ status' = "paused" /\ runner' = "none"
            /\ resumeRunner' = IF status = "working" THEN runner ELSE resumeRunner
            /\ resumeWasAvailable' = FALSE
       ELSE UNCHANGED <<status, runner, resumeRunner, resumeWasAvailable>>
  /\ UNCHANGED <<seat, piModel, workerLive, appLive, roomLive, kind>>

Wake ==
  /\ mac = "asleep" /\ mac' = "awake"
  /\ status' = IF status \in {"paused", "held"} THEN "arrived" ELSE status
  /\ UNCHANGED <<seat, piModel, workerLive, appLive, roomLive, kind,
                 runner, resumeRunner, resumeWasAvailable>>

Next == Arrive \/ Route \/ Finish \/ Reset
        \/ SeatStarts \/ PiStarts \/ AppReadsInbox \/ RoomStarts
        \/ SeatStops \/ PiStops \/ AppStops \/ RoomStops \/ WorkerStops
        \/ WorkerComesOrGoes \/ Sleep \/ Wake

Spec == Init /\ [][Next]_vars

SocialNeverUsesOwnerSession == kind = "social" => runner \notin {"seat", "pi", "worker", "app"}
SocialNeverQueued == kind = "social" => status # "held"
PushNotPull == (status = "held" /\ mac = "awake") => PreferredRunner = "none"
OwnedWorkGoesToOwner ==
  (status = "working" /\ kind = "tagOwned" /\ workerLive) => runner = "worker"
NothingRunsAsleep == mac = "asleep" => runner = "none"
OriginalRunnerFirst == (status = "working" /\ resumeWasAvailable) => runner = resumeRunner
\* Drawing-only bound. The full config checks every availability combination.
ChartBound == Cardinality({r \in {"seat", "pi", "worker", "app"} : Available(r)}) <= 1
====
