import requests
import json

TENANT_ID = "327144c0-27c8-4b39-a433-ec8b0bfca77f"
CLIENT_ID = "260bc477-4951-4b94-9dbc-9b378bcc5abc"
CLIENT_SECRET = "EQ88Q~cvo~gRbE5bILbzn4PKtMyQ5uncW-sD3bE_"
USER_ID = "CK86X9PmrvKhnGtiLUazN-dy0lsCqyVfMG0RY2yKxTY"

# Get app token
token_resp = requests.post(
    f"https://login.microsoftonline.com/{TENANT_ID}/oauth2/v2.0/token",
    data={
        "grant_type": "client_credentials",
        "client_id": CLIENT_ID,
        "client_secret": CLIENT_SECRET,
        "scope": "https://graph.microsoft.com/.default",
    },
)
access_token = token_resp.json()["access_token"]
print("Got token")

# Try direct lookup by userId

# url = "https://graph.microsoft.com/v1.0/users"
# url += f"?$filter=identities/any(i:i/issuerAssignedId eq '{USER_ID}')"
# url += "&$select=id,mail,userPrincipalName,displayName,givenName,surname"
# resp = requests.get(url, headers={"Authorization": f"Bearer {access_token}"})
# print("Filter lookup status:", resp.status_code)
# print(json.dumps(resp.json(), indent=2))

# GUEST_EMAIL = "hrishi.logani@ubc.ca"
# url = f"https://graph.microsoft.com/v1.0/users/{GUEST_EMAIL}"
# url += "?$select=id,mail,userPrincipalName,displayName,givenName,surname"
# resp = requests.get(url, headers={"Authorization": f"Bearer {access_token}"})
# print("Email lookup status:", resp.status_code)
# print(json.dumps(resp.json(), indent=2))

# url = "https://graph.microsoft.com/v1.0/users"
# url += "?$filter=userType eq 'Guest'"
# url += "&$select=id,mail,userPrincipalName,displayName,identities"
# resp = requests.get(url, headers={"Authorization": f"Bearer {access_token}"})
# print(json.dumps(resp.json(), indent=2))

# UPN = "hrishi.logani_ubc.ca#EXT#@CICPROTODEV.onmicrosoft.com"
# url = f"https://graph.microsoft.com/v1.0/users/{UPN}"
# url += "?$select=id,mail,userPrincipalName,displayName,givenName,surname"
# resp = requests.get(url, headers={"Authorization": f"Bearer {access_token}"})
# print(json.dumps(resp.json(), indent=2))

UPN = "hrishi.logani_ubc.ca#EXT#@CICPROTODEV.onmicrosoft.com"
url = f"https://graph.microsoft.com/v1.0/users/{UPN}/memberOf"
url += "?$select=id,displayName,description"
resp = requests.get(url, headers={"Authorization": f"Bearer {access_token}"})
print("Group memberships:", json.dumps(resp.json(), indent=2))