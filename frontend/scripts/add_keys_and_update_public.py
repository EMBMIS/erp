#!/usr/bin/env python3
import json
import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EN_JSON = os.path.join(BASE_DIR, 'src', 'i18n', 'locales', 'en.json')

NEW_KEYS = {
    "sending": "Sending...",
    "sendResetLink": "Send reset link",
    "resetting": "Resetting...",
    "resetPassword": "Reset password",
    "somethingWentWrongOnThisScreen": "Something went wrong on this screen",
    "anUnforeseenRenderingErrorOccurred": "An unforeseen rendering error occurred. You can retry without losing your current session.",
    "reloadPage": "Reload Page",
    "verificationEmailSent": "Verification email sent.",
    "couldNotResend": "Could not resend — try again shortly.",
    "resendVerificationEmail": "Resend verification email",
    "emailIsRequired": "Email is required",
    "pleaseEnterAValidEmailAddress": "Please enter a valid email address",
    "passwordIsRequired": "Password is required",
    "passwordMustBeAtLeast6CharactersLong": "Password must be at least 6 characters long",
    "loginFailedPleaseTryAgain": "Login failed. Please try again.",
    "noSuggestionPickABusinessTypeBelow": "No suggestion — pick a business type below",
    "enterAValidEmailAddress": "Enter a valid email address",
    "atLeast6Characters": "At least 6 characters",
    "thisResetLinkIsMissingItsToken": "This reset link is missing its token. Request a new one.",
    "passwordsDoNotMatch": "Passwords do not match",
    "passwordResetPleaseSignIn": "Password reset. Please sign in with your new password.",
    "thisPasswordResetLinkIsInvalidOrHasExpired": "This password reset link is invalid or has expired.",
    "contractNotFoundOrNoLongerAvailable": "Contract not found or no longer available for response",
    "failedToLoadContractDetails": "Failed to load contract details",
    "pleaseSelectAcceptOrDecline": "Please select accept or decline",
    "pleaseEnterYourName": "Please enter your name",
    "pleaseEnterYourEmail": "Please enter your email",
    "failedToSubmitResponse": "Failed to submit response",
    "pleaseDescribeTheDeliveryIssue": "Please describe the delivery issue",
    "deliveryConfirmationNotFound": "Delivery confirmation not found",
    "failedToConfirmDelivery": "Failed to confirm delivery",
    "failedToReportDeliveryIssue": "Failed to report delivery issue",
    "notSpecified": "Not specified",
    "pleaseFillInYourNameAndEmailAddress": "Please fill in your name and email address",
    "failedToLoadOrderDetails": "Failed to load order details",
    "quotationNotFoundOrNoLongerAvailable": "Quotation not found or no longer available for response",
    "failedToLoadQuotationDetails": "Failed to load quotation details",
    "yourDeliveryIssueHasBeenReportedSuccessfully": "Your delivery issue has been reported successfully. Our team will contact you shortly.",
    "thankYouForConfirmingYourDelivery": "Thank you for confirming your delivery! Your order is now complete.",
    "issueReported": "Issue Reported",
    "deliveryConfirmed": "Delivery Confirmed!"
}

# Update en.json
with open(EN_JSON, 'r', encoding='utf-8') as f:
    en_data = json.load(f)

if 'ui' not in en_data:
    en_data['ui'] = {}

added = 0
for k, v in NEW_KEYS.items():
    if k not in en_data['ui']:
        en_data['ui'][k] = v
        added += 1

with open(EN_JSON, 'w', encoding='utf-8') as f:
    json.dump(en_data, f, ensure_ascii=False, indent=2)
    f.write('\n')

print(f"Added {added} new keys to en.json.")
