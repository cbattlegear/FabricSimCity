namespace SqlSimCity.Api;

/// <summary>
/// Selects which <c>ILiveIncidentCollector</c> backs <c>/api/v1/live</c> and the live-incident
/// SignalR push. <see cref="Fixture"/> is the default and requires no configuration or
/// credentials (requirement 7); <see cref="Connected"/> opts a host into a real SQL Server
/// connection and requires <c>LiveIncidents:Connection</c> to be fully and validly configured
/// before the host will start serving traffic.
/// </summary>
public enum LiveIncidentsMode
{
    Fixture,
    Connected,
}
